# photoweather-forecast-archive

## 中文

本仓库只做一件事：每小时（第 23 分）定时抓取 Open-Meteo 的 GFS 预报「当时发布的原文」，按提前量桶存入 `eval/archive/`，供摄影师天气项目做预报评测。原文字节不改，每份附带清单（sha256、抓取时间）。

- 只含 0.1° 量化格点（见 `eval/sites/fixed-sites.json`），不含任何精确机位或个人位置。
- 抓取代码来自主项目（Apache-2.0），导出自主项目的 `scripts/export-archive-repo.mjs`；`export-meta.json` 记录来源提交与生成时间。
- 主项目：待公开。
- 本机运行：`pnpm install --frozen-lockfile` 后 `pnpm capture`（可加 `-- --dry-run` 只打印不联网）。

## English

This repository does one thing: every hour (minute 23) it captures the as-published Open-Meteo GFS forecast responses and stores them, unmodified, under `eval/archive/` by lead-time bucket, for forecast evaluation in the PhotoWeather project. Each raw file has a manifest (sha256, retrieval time).

- Only 0.1-degree quantised grid points are included (`eval/sites/fixed-sites.json`); no exact shooting positions or personal locations.
- The capture code comes from the main project (Apache-2.0), exported by its `scripts/export-archive-repo.mjs`; `export-meta.json` records the source commit and generation time.
- Main project: to be published.
- Local run: `pnpm install --frozen-lockfile`, then `pnpm capture` (add `-- --dry-run` to print only, no network).

## Data source and attribution / 数据来源与署名

Weather data by [Open-Meteo.com](https://open-meteo.com/). Open-Meteo API data are offered under Attribution 4.0 International (CC BY 4.0): https://open-meteo.com/en/licence (terms: https://open-meteo.com/en/terms). The data in `eval/archive/` stay under CC BY 4.0; when reusing them, give credit to Open-Meteo, link to the licence, and indicate if changes were made. The free API is for non-commercial use only.

`eval/archive/` 中的数据来自 Open-Meteo，按 CC BY 4.0 使用；复用时请署名 Open-Meteo、附授权链接并说明是否做过修改。免费 API 仅限非商业用途。

## Licence / 许可

Code: Apache-2.0 (see `LICENSE`). Data in `eval/archive/`: CC BY 4.0 (Open-Meteo), see above.
