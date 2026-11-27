#!/usr/bin/env bash
# Isolated Firestore emulator test runner. Never deploys or uses production credentials.
# Run: bash b2b/emulator-check.sh
# Requires Node.js 22+, Java 21+, npm and network for first-time dependencies.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
export CI=true
unset GOOGLE_APPLICATION_CREDENTIALS FIREBASE_TOKEN GCLOUD_PROJECT GOOGLE_CLOUD_PROJECT FIRESTORE_EMULATOR_HOST
cat > package.json <<'JSON'
{"private":true,"type":"module","dependencies":{"@firebase/rules-unit-testing":"4.0.1","firebase":"11.10.0","firebase-tools":"14.12.0"}}
JSON
cat > firebase.json <<'JSON'
{"firestore":{"rules":"firestore.rules"},"emulators":{"firestore":{"host":"127.0.0.1","port":18080},"ui":{"enabled":false},"singleProjectMode":true}}
JSON
# Compile the existing membership/trade fragment, not production rules.
# The additional lock rules below are an isolated candidate only, not production integration.
printf '%s\n' "rules_version = '2';" "service cloud.firestore {" "match /databases/{database}/documents {" > firestore.rules
cat "$here/firestore.rules.fragment" >> firestore.rules
cat >> firestore.rules <<'RULES'

// Isolated candidate: one public inventory state and one private order per unique animal.
// Both writes must occur in the same atomic transaction. No direct payment or CITES transitions.
match /b2b_test_stock/{id} {
  allow read: if tradeRole('buyer') || tradeRole('admin');
  allow update: if tradeRole('buyer') &&
    resource.data.available == true &&
    request.resource.data.available == false &&
    request.resource.data.diff(resource.data).affectedKeys().hasOnly(['available']) &&
    !exists(/databases/$(database)/documents/b2b_test_orders/$(id)) &&
    getAfter(/databases/$(database)/documents/b2b_test_orders/$(id)).data.buyer == request.auth.uid;
}
match /b2b_test_orders/{id} {
  allow get: if tradeRole('admin') || (tradeRole('buyer') && resource.data.buyer == request.auth.uid);
  allow create: if tradeRole('buyer') &&
    request.resource.data.keys().hasOnly(['buyer','state','createdAt']) &&
    request.resource.data.keys().hasAll(['buyer','state','createdAt']) &&
    request.resource.data.buyer == request.auth.uid &&
    request.resource.data.state == 'reserved' &&
    request.resource.data.createdAt == request.time &&
    get(/databases/$(database)/documents/b2b_test_stock/$(id)).data.available == true &&
    getAfter(/databases/$(database)/documents/b2b_test_stock/$(id)).data.available == false;
  allow update, delete: if false;
}
}
}
RULES
cat > check.mjs <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment, assertFails, assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,getDoc,getDocs,collection,setDoc,updateDoc,writeBatch,serverTimestamp,runTransaction,onSnapshot} from 'firebase/firestore';
const projectId='demo-hm-b2b-test';
if(process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:18080') throw new Error('Refusing non-local Firestore');
const env=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:18080,rules:readFileSync('firestore.rules','utf8')}});
let count=0;
const test=async(name,fn)=>{await fn(); console.log('PASS '+name); count++};
const client=(uid,email=uid+'@example.invalid')=>env.authenticatedContext(uid,{email,email_verified:true}).firestore();
const admin=client('admin'), seller=client('seller'), buyer=client('buyer'), buyer2=client('buyer2'), pending=client('pending'), stranger=client('stranger'), revoked=client('revoked');
const anon=env.unauthenticatedContext().firestore();
const d=(db,c,id)=>doc(db,c,id);
const entry={species:'ball',genes:'TEST',sex:'F',amount:8000};
const appData=(role='buyer')=>({business:'Synthetic test shop',email:'pending@example.invalid',requestedRole:role,status:'pending',createdAt:serverTimestamp()});
const member=(db,id)=>d(db,'b2b_members',id);
const app=(db,id)=>d(db,'b2b_applications',id);
const invite=(db,id)=>d(db,'b2b_invites',id);
const stock=db=>d(db,'b2b_test_stock','animal-test');
const order=db=>d(db,'b2b_test_orders','animal-test');
async function reserve(db,uid) {
  return runTransaction(db,async tx=>{
    const s=await tx.get(stock(db));
    if(!s.exists()||s.data().available!==true)throw new Error('already reserved');
    tx.update(stock(db),{available:false});
    tx.set(order(db),{buyer:uid,state:'reserved',createdAt:serverTimestamp()});
  });
}
try {
 await env.clearFirestore();
 await env.withSecurityRulesDisabled(async ctx=>{
   const db=ctx.firestore();
   for(const [uid,role] of [['admin','admin'],['seller','seller'],['buyer','buyer'],['buyer2','buyer']]) await setDoc(member(db,uid),{roles:[role],active:true});
   await setDoc(invite(db,'pending@example.invalid'),{role:'buyer',active:true});
   await setDoc(invite(db,'revoked@example.invalid'),{role:'seller',active:false});
   await setDoc(d(db,'b2b_supply_private','animal-test'),{...entry,owner:'seller'});
   await setDoc(d(db,'b2b_supply_public','animal-test'),{...entry,amount:10000});
   await setDoc(d(db,'b2b_wish_private','wish-test'),{...entry,owner:'buyer'});
   await setDoc(d(db,'b2b_wish_public','wish-test'),entry);
   await setDoc(stock(db),{available:true});
 });
 await test('anonymous and uninvited users cannot read catalog',async()=>{
   for(const db of [anon,stranger,pending]) await assertFails(getDoc(d(db,'b2b_supply_public','animal-test')));
 });
 await test('invite email cannot be borrowed or enumerated',async()=>{
   await assertFails(getDoc(invite(stranger,'pending@example.invalid')));
   await assertFails(getDocs(collection(stranger,'b2b_invites')));
   await assertSucceeds(getDoc(invite(pending,'pending@example.invalid')));
   await assertFails(setDoc(app(revoked,'revoked'),{...appData('seller'),email:'revoked@example.invalid'}));
 });
 await test('role tampering and self approval rejected',async()=>{
   await assertFails(setDoc(app(pending,'pending'),appData('seller')));
   await assertFails(setDoc(member(pending,'pending'),{roles:['admin'],active:true,updatedAt:serverTimestamp()}));
   await assertSucceeds(setDoc(app(pending,'pending'),appData()));
   await assertFails(updateDoc(app(pending,'pending'),{status:'approved',reviewedAt:serverTimestamp()}));
   await assertFails(getDoc(app(stranger,'pending')));
 });
 await test('approval must be atomic; role fixed and single',async()=>{
   await assertFails(setDoc(member(admin,'pending'),{roles:['buyer'],active:true,updatedAt:serverTimestamp()}));
   const bad=writeBatch(admin);
   bad.set(member(admin,'pending'),{roles:['buyer','seller'],active:true,updatedAt:serverTimestamp()});
   bad.update(app(admin,'pending'),{status:'approved',reviewedAt:serverTimestamp()});
   await assertFails(bad.commit());
   const good=writeBatch(admin);
   good.set(member(admin,'pending'),{roles:['buyer'],active:true,updatedAt:serverTimestamp()});
   good.update(app(admin,'pending'),{status:'approved',reviewedAt:serverTimestamp()});
   await assertSucceeds(good.commit());
   await assertSucceeds(getDoc(d(pending,'b2b_supply_public','animal-test')));
   await assertFails(updateDoc(member(admin,'pending'),{roles:['seller'],updatedAt:serverTimestamp()}));
 });
 await test('buyer and seller cannot see opposite private prices',async()=>{
   await assertSucceeds(getDoc(d(buyer,'b2b_supply_public','animal-test')));
   await assertSucceeds(getDoc(d(seller,'b2b_wish_public','wish-test')));
   await assertSucceeds(getDoc(d(seller,'b2b_supply_private','animal-test')));
   await assertFails(getDoc(d(buyer,'b2b_supply_private','animal-test')));
   await assertFails(getDoc(d(seller,'b2b_wish_private','wish-test')));
   await assertFails(getDoc(d(buyer2,'b2b_wish_private','wish-test')));
   await assertFails(getDoc(d(seller,'b2b_supply_public','animal-test')));
   await assertFails(getDocs(collection(buyer,'b2b_supply_private')));
   await assertFails(updateDoc(d(buyer,'b2b_supply_public','animal-test'),{amount:1}));
 });
 await test('suspension blocks protected reads and writes',async()=>{
   await assertSucceeds(updateDoc(member(admin,'pending'),{active:false,updatedAt:serverTimestamp()}));
   await assertFails(getDoc(d(pending,'b2b_supply_public','animal-test')));
   await assertFails(setDoc(d(pending,'b2b_wish_private','new'),{...entry,owner:'pending',createdAt:serverTimestamp()}));
 });
 await test('direct partial lock or forged order rejected',async()=>{
   await assertFails(updateDoc(stock(buyer),{available:false}));
   await assertFails(setDoc(order(buyer),{buyer:'buyer',state:'reserved',createdAt:serverTimestamp()}));
   await assertFails(reserve(seller,'seller'));
 });
 await test('two buyers race; exactly one order; listener sees locked state',async()=>{
   let stop,timer;
   const observed=new Promise((resolve,reject)=>{
     timer=setTimeout(()=>reject(new Error('listener timed out')),10000);
     stop=onSnapshot(stock(buyer2),s=>{
       if(s.exists()&&s.data().available===false&&!s.metadata.hasPendingWrites){clearTimeout(timer);resolve();}
     },reject);
   });
   try{
     const results=await Promise.allSettled([reserve(buyer,'buyer'),reserve(buyer2,'buyer2')]);
     assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
     const winner=results[0].status==='fulfilled'?buyer:buyer2;
     const loser=winner===buyer?buyer2:buyer;
     assert.equal((await getDoc(stock(admin))).data().available,false);
     assert.equal((await getDoc(order(admin))).data().state,'reserved');
     await assertSucceeds(getDoc(order(winner)));
     await assertFails(getDoc(order(loser)));
     await assertFails(updateDoc(order(winner),{state:'paid'}));
     await assertFails(reserve(loser,loser===buyer?'buyer':'buyer2'));
     await observed;
   }finally{clearTimeout(timer);stop?.();}
 });
 console.log('Completed '+count+' emulator test groups. Candidate lock only; no production integration.');
} finally {await env.cleanup();}
JS
npm install --no-audit --no-fund
# Explicit demo project ID; no Firebase login or deployment commands.
./node_modules/.bin/firebase emulators:exec --only firestore --project demo-hm-b2b-test 'node check.mjs'
