HM Python × SOTA Reptile Studio — SOTA Feed

正式 endpoint（部署到現有 hmpython.netlify.app site 後）：
https://hmpython.netlify.app/api/sota-feed

檔案：
- index.html：2026-08-18 最新前台
- admin.html：2026-08-18 最新後台，已含「顯示於 SOTA」與 SOTA 展示說明
- netlify/functions/sota-feed.js：唯讀 JSON Feed
- netlify.toml：將 /api/sota-feed 導向 Netlify Function

重要：
此套件必須以支援 Netlify Functions 的方式部署（Git deploy 或 Netlify CLI deploy）。
只把 index.html/admin.html 單獨拖曳到網站，不會部署 serverless function。

Feed 規則：
- 僅 species === ball_python 且 showOnSota === true
- 售出 status === sold 時 available=false，但仍留在 Feed
- 取消 showOnSota 後從 Feed 移除
- source_id = Firestore snakes document ID
- 圖片僅輸出 HTTPS URL
- 不輸出 price、cost、聯絡資訊、HM 網址、社群、客戶/後台欄位
- API 只支援 GET / OPTIONS，不提供任何寫入方法
- CORS 允許 https://sotareptile.com 與 https://www.sotareptile.com
