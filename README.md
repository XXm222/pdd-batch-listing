<p align="center">
  <img src="docs/assets/readme-banner.svg" alt="电商批量上架助手" width="100%">
</p>

<h1 align="center">电商批量上架助手</h1>

<p align="center">给多家网店上新，只需从 Excel 导入一次商品图片、规格、价格和库存。</p>

<p align="center"><strong>已适配拼多多，抖音电商（抖店）和淘宝即将上线。</strong></p>

<p align="center">
  <a href="https://github.com/XXm222/ecommerce-batch-listing/releases/latest"><img alt="最新版本" src="https://img.shields.io/github/v/release/XXm222/ecommerce-batch-listing?label=Release&amp;color=16836b"></a>
  <a href="https://github.com/XXm222/ecommerce-batch-listing/actions/workflows/ci.yml"><img alt="代码检查" src="https://github.com/XXm222/ecommerce-batch-listing/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="PolyForm Noncommercial 1.0.0" src="https://img.shields.io/badge/License-PolyForm%20Noncommercial-53627c"></a>
</p>

<p align="center">
  <a href="#下载安装"><strong>下载安装</strong></a> · <a href="#快速上手">快速上手</a> · <a href="#本地开发">本地开发</a> · <a href="项目文档/README.md">项目文档</a>
</p>

## 多店铺批量上架

| 使用场景 | 怎么操作 |
| --- | --- |
| **单件商品上架到多家店铺** | 勾选这件商品，为第一家店保存草稿，再为下一家店勾选同一件商品。各店复用同一份资料。 |
| **多件商品批量上架到多家店铺** | 一次导入多件商品，按每家店的上新清单勾选商品，分店批量保存草稿。各店可以选不同的商品组合。 |

当前拼多多版本每批选择一家目标店铺。草稿保存后，由商家在该店的拼多多后台核对并发布。

## 下载安装

| Windows x64 | macOS · Apple Silicon |
| --- | --- |
| [**下载 Setup**](https://www.mandla.cn/goods-updates/windows-x64.exe) | [**下载 DMG**](https://www.mandla.cn/goods-updates/mac-arm64.dmg) |

当前公开安装包（0.1.65）的应用名称为 **商品运营台**。安装包自带运行时，后续可在「设置 → 软件更新」检查更新。macOS 安装包尚未完成 Apple Developer ID 签名与公证。详情和校验文件见 [GitHub Releases](https://github.com/XXm222/ecommerce-batch-listing/releases/latest)。

## 核心功能

| 功能 | 可以做什么 |
| --- | --- |
| **商品资料导入** | 一份 Excel 对应一件商品，可一次选择多份。支持文件夹导入、普通内嵌图片和 WPS DISPIMG。 |
| **多规格编辑** | 按组合核对规格图、拼单价、单买价、库存和编码，集中整理轮播图、详情图、发货服务和安装设置。 |
| **草稿核对** | 保存后回读字段并核对草稿箱。进度、耗时与结果保存在本机。 |
| **店铺商品导出** | 搜索在售商品并跨页勾选，一次最多 50 件。单件导出含图 Excel，多件打包成 ZIP。 |

<p align="center">
  <img src="docs/assets/shop-export-preview.png" alt="商品运营台店铺商品导出页，展示来源店铺、搜索、商品列表和底部导出操作栏" width="100%">
  <br>
  <sub>店铺商品导出 · 0.1.64 界面演示</sub>
</p>

## 快速上手

1. **准备资料**。在 App 下载 Excel 模板，按需填写商品、规格与图片。 [模板](resources/templates/商品资料模板.xlsx) · [填写示例](resources/templates/商品资料示例.xlsx) · [资料规范](项目文档/05运营资料规范.md)
2. **导入并核对**。点击「上传 Excel」，核对基本资料、规格与价格、商品图片、发货与服务，再保存到本机。
3. **连接浏览器并选店**。从 App 打开「设置 → 浏览器连接 → 连接教程」，在 Chrome 或 Edge 中加载 Kimi 浏览器扩展，确认目标店铺已登录。使用本机资料功能时可跳过此步。
4. **保存草稿并查看结果**。勾选一件或多件商品，选择一家目标店铺，点击「开始填写并保存草稿」。在执行记录中核对结果。要上架到下一家店铺时，再次勾选商品并选择该店铺即可。遇到验证码时按提示在浏览器中完成验证。

## 本地开发

**Electron · React · TypeScript · Vite · SQLite（sql.js）**

开发环境使用 Node.js `24.19.0` 和 pnpm `11.19.0`。

```bash
git clone https://github.com/XXm222/ecommerce-batch-listing.git
cd ecommerce-batch-listing
pnpm install --frozen-lockfile
node node_modules/electron/install.js
pnpm dev
```

`pnpm dev` 同时启动 Vite 和 Electron。可通过 `GOODS_WORKSPACE_DATA_DIR` 指定独立的测试资料目录。

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

[技术架构](项目文档/02技术选型与架构.md) · [维护与发布](项目文档/33维护交接与更新发布.md) · [验收记录与历史版本](项目文档/README.md#版本与验证)

## 许可

项目源码公开，采用 **PolyForm Noncommercial 1.0.0**。用于经营店铺、公司业务或商业分发前，请取得权利人书面许可。第三方依赖与浏览器扩展适用各自许可。 [LICENSE](LICENSE) · [NOTICE](NOTICE) · [联系维护者](https://github.com/XXm222/ecommerce-batch-listing/issues/new)
