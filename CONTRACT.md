# 房屋修圖器 — 開發規格（各 Agent 共同遵守）

## 產品
房仲用手機修圖：拍完物件照片 → 塗掉雜物 → AI 移除 → 存回手機上架。使用者不會寫程式，**越簡單越好**。介面全部用**繁體中文**，手機直式、單手操作優先。

## 技術限制
- 純靜態網頁 PWA：**原生 ES Modules，不用 npm、不用打包工具**（電腦沒有 Node）。
- 外部函式庫只能從 CDN 載入並**鎖定精確版本**（例如 `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/...`）。
- AI 在**手機瀏覽器端**執行（onnxruntime-web，WASM 為主，WebGPU 有就用）。
- 強力模式：Google Gemini 圖像編輯 API，使用者自己填 API Key（存在手機 localStorage）。

## 檔案分工（各自只動自己的檔案）
| 檔案 | 負責 |
|---|---|
| `index.html`, `styles.css`, `app.js`, `lib/*.js`（UI 用） | Agent A（UI） |
| `engine/local.js`, `models/*` | Agent B（本機 AI 引擎） |
| `engine/gemini.js`, `manifest.webmanifest`, `sw.js`, `icons/*`, `serve.ps1`, `README.md` | Agent C（Gemini + PWA + 開發伺服器 + 說明） |

## 介面約定

### 遮罩（mask）格式
- `HTMLCanvasElement`，**尺寸與原圖完全相同**。
- 背景黑色不透明 `#000`，要移除的區域塗**白色** `#fff`。判斷規則：`R > 127` 即為要移除。

### `engine/local.js`
```js
export async function loadLocalModel(onProgress)        // 預先載入模型；onProgress({loaded,total,stage})；可重複呼叫（有快取）
export async function inpaintLocal(imageCanvas, maskCanvas, onProgress) // → Promise<HTMLCanvasElement>，尺寸＝原圖
export function getLocalEngineInfo()                     // → {name, backend:'wasm'|'webgpu', ready:boolean}
```
- 必須處理手機大圖（4000×3000）：只裁切遮罩外框＋留邊的區域去修，修完縮放回去，**只在遮罩區域（稍微擴張＋羽化）貼回原圖**，其他像素保持原樣、原解析度。
- 模型檔先找 `models/` 底下的相對路徑，找不到再從 HuggingFace 網址載入。用 Cache Storage 快取，第二次開啟不用重新下載。

### `engine/gemini.js`
```js
export async function inpaintGemini(imageCanvas, maskCanvas, {apiKey, prompt, onProgress}) // → Promise<HTMLCanvasElement>，尺寸＝原圖
export async function declutterGemini(imageCanvas, {apiKey, prompt, onProgress})        // 不需遮罩，一鍵整理 → canvas，尺寸＝原圖
export async function testGeminiKey(apiKey)  // → {ok:boolean, message:string}
export const GEMINI_DEFAULT_PROMPT           // 預設中文/英文指令
```
- `inpaintGemini`：送出原圖＋標示遮罩的圖，取回結果後**只在遮罩區域（擴張＋羽化）貼回原解析度原圖**。
- `declutterGemini`：整張圖替換，結果放大回原尺寸。
- 錯誤要丟出人看得懂的中文訊息（金鑰錯誤、額度用完、網路問題、安全過濾）。

## 合規（App 必須內建）
- 永遠保留原圖，不覆蓋。
- 輸出時可選加小字浮水印「照片經整理示意」（預設開啟）。
- 介面提醒：只移除可移動的雜物，不可移除壁癌、漏水、裂縫、窗外嫌惡設施（不動產經紀業管理條例 §21、公平交易法 §21）。

## 開發伺服器
`serve.ps1`：用 PowerShell 內建 HttpListener 提供靜態檔案（port 8080），正確設定 `.js`→`text/javascript`、`.onnx`→`application/octet-stream`、`.webmanifest`→`application/manifest+json`、`.wasm`→`application/wasm`。
