# 淘宝/天猫「发布商品 → 保存草稿」自动化 Workflow

日期：2026-10-06 · 店铺：摩狮度旗舰店（天猫，sellerId `2217745162564`）· 数据源：`运营资料/泡脚桶示例.xlsx`（PDD 模板）

本文是一份**可直接照着实现**的流程说明。全部步骤都在真实后台跑通过一次，产出的草稿：
**商品ID `1090661312520`，「仓库中」，标题「可折叠泡脚桶 家用便携」，编码 FB001，¥49.90，库存 18**。

---

## 0. 三条必须遵守的硬规则

这三条是本次踩了几小时坑才定位到的，违反任何一条都会出现「页面上看着填好了、但按钮永远灰」的假象。

### 规则 1：所有控件定位必须过滤「可见且有尺寸」

页面会同时保留**同一套控件的多份实例**，其中一份未布局（`getBoundingClientRect()` 为 `0×0`）。
`document.querySelector('#struct-p-20000 …')` 命中的往往是**先出现的隐藏副本**，往它填值
DOM 上「看起来生效」（`em[title]`、`next-has-clear`、计数器全变），但 React 状态没变。

```js
const shown = (e) => {
  if (!e) return false;
  const b = e.getBoundingClientRect();
  return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden';
};
// 永远这样取：
const trigger = [...document.querySelectorAll('#struct-p-20000 .next-select-trigger')].find(shown);
```

### 规则 2：文本输入必须走真实键盘事件，不能用 DOM 赋值

扩展的 `fill`（`input.value = v` + 派发 `input`）只改 DOM，**React 受控组件不会更新**，
「确认，下一步」不会因此变可用。必须用 CDP 真实输入：

```js
async function typeInto(elementCode, value) {
  const focused = await evaluate(`(() => {${SHOWN}
    const e=${elementCode}; if(!e) return 'not-found';
    e.scrollIntoView({block:'center'}); e.focus();
    if (typeof e.setSelectionRange === 'function') e.setSelectionRange(0, e.value.length);
    return document.activeElement === e ? 'focused' : 'not-focused';
  })()`);
  if (focused !== 'focused') return focused;
  await call('cdp', { method: 'Input.insertText', params: { text: value } });
  await key('Tab', 'Tab', 9);   // 提交/失焦
  return 'typed';
}
```

顺带两个坑：
- 输入框**多数没有显式 `type` 属性**，`input[type=text]` 选不到它们；用
  `input:not([type])` 或 `[...root.querySelectorAll('input')].filter(e => !['checkbox','radio','file','hidden'].includes(e.type))`。
- 读取时别拿 `root.querySelector('input')`——商品标题那一行的第一个 input 是「使用品牌名」勾选框。

### 规则 3：下拉/规格值用 Tab 或真实鼠标提交，Enter 常常无效

- 规格值输入框（`placeholder="输入规格"`）：**按 Tab 才提交**，Enter 无效。
- 地区级联（省→市）：必须**点到最后一级（市）**才会写回；只点省不会提交。
- 普通 Select 选项：扩展的 `click`（`el.click()`）多数可用；个别（如发货地）需要 CDP 真实鼠标事件。

---

## 1. 流程总览

```
① 入口            商品 → 发布商品 → upload.taobao.com/auction/sell.jhtml
                  → 302 → sell.publish.tmall.com/tmall/ai/category.htm
② 选以图发品      点 .item-tab（文本「以图发品」；默认是「搜索发品」）
③ 上传主图        input[type=file][accept="image/jpg,image/bmp,image/png,image/jpeg"]
④ 进 AI 确认页    「确认，下一步」（上传成功后自动可用）→ 同一 URL 换成确认视图
⑤ 确认类目参数    选类目路径（.path-name）→ 选品牌 → 填货号 → 「确认，下一步」
⑥ 商品表单        /tmall/publish.htm?catId=…&kp={…}&fromAIPublish=true
                  基础信息 → 销售信息 → 物流售后及其他 → 图文描述
⑦ 建 SKU          「＋创建规格」抽屉：自定义填写规格 → 规格值（Tab 提交）→ 确认创建
⑧ 填 SKU 表        每行价格/数量
⑨ 上架时间        【放入仓库】（默认就是选中项）
⑩ 提交            「提交」→ 成功页 success.htm?primaryId=<itemId>
⑪ 读回            我的商品 → 仓库中（SellManage/in_stock）按商品ID搜索核对
```

---

## 2. 逐步说明（含真实选择器）

### ① 入口

| 项 | 值 |
| --- | --- |
| 千牛顶部导航 | `/home.htm/_firstmenuid_/2488` |
| 「发布商品」 | `https://upload.taobao.com/auction/sell.jhtml` |
| 302 落地 | `https://sell.publish.tmall.com/tmall/ai/category.htm` |

> `item.upload.tmall.com/router/publish.htm` 是即将下线的经典页，**不要用**。
> 未保存表单会弹 `beforeunload`，导航时需 `dialog{action:"accept"}` 放行。

### ② 切到「以图发品」

```js
[...document.querySelectorAll('.item-tab')].find(e => shown(e) && e.innerText.trim() === '以图发品')
```

为什么用「以图发品」：页面自述它面向**无法规划化分类的非标类产品、全品类适用**；
「搜索发品」面向有明确型号的标准品。泡脚桶属非标品。
两条路后面共用同一套参数区，`搜索发品` 走的是「关键词 → 选 `.sell-rich-text.path-text` 推荐路径」。

### ③ 上传主图

```js
const input = document.querySelector('input[type=file]');   // accept=image/jpg,image/bmp,image/png,image/jpeg，multiple
// 通过桥接一次上传多张：
await call('upload', { selector: '[data-upload]', files: [main01, main02, main03, main04, main05, detail01, ...] });
```

**这一步决定主图和详情的数量，必须一次多传。** 实测：

| 上传张数 | 系统分配结果 |
| --- | --- |
| 1 张 | 1:1主图 1 张、宝贝详情 1 张 |
| 8 张（5 主图 + 3 详情） | **1:1主图 5 张、宝贝详情 12 张** |

系统会「剪裁并分装归类」：主图类图片进 1:1主图（上限 5），其余进宝贝详情。
只传一张就会得到「详情页只有 1 张图」的结果，需要回这一步重新多传。

上传成功后页面提示「上传成功！根据传入的图片，已为您剪裁并分装归类」，
此时「确认，下一步」可用。

**图片要求**：1:1，推荐 ≥1440×1440，≤3MB，png/jpg/jpeg。
真实商品素材（`运营资料/真实泡脚桶-含图片.xlsx` 或同名 zip 包）是 10 张主图 + 25 张详情图，
主图 1440×1440、详情图 790×1211 竖版长图，可直接用。

### ③b 图片落位核对（必做）

上传后表单里一共有 7 个图片位，**提交前必须逐个核对数量**，否则会出现「图传了但不在该在的地方」：

| 字段 id | 名称 | 期望值 |
| --- | --- | --- |
| `mainImagesGroup` | 1:1主图 | **5**（上限 5；从 xlsx 的 10 张轮播图里取前 5） |
| `descRepublicOfSell` | 宝贝详情 | 上传的详情图数量（实测 24） |
| `threeToFourImages` | 3:4主图 | 0（可选，需从 1:1 主图裁剪） |
| `diaopai` | 吊牌图 | 0 |
| `yinHeWhiteBgImage` | 白底图 | 0（可选，要求 800×800 纯白底） |
| `uspImageV3` | 卖点图 | 0（可选，需另外制作） |
| `guideImageGroup` | 导购素材 → **透明素材图** | **1，且是平台自动生成的** |

`guideImageGroup` 这一项容易被误判成「详情图串位」：实测它始终是 1 张，且
**URL 是 `.png`**（如 `...O1CN01LWlfeP...png_320x320q80_.webp`），而上传的素材全是 `.jpg`
（形如 `...jpg`，还可能带 `~crop,x,y,w,h~` 裁剪参数）。它是天猫从主图**自动抠出的透明底图**
（字段要求 800×800 透明 PNG），每次都会生成、界面上也没有删除控件，属于平台派生字段，不是串位。
核对方法：

```js
const guide = document.querySelector('#sell-field-guideImageGroup img');
const isPlatformCutout = /\\.png/.test(guide.src);   // true = 平台生成，不是上传的素材
```

### ④⑤ AI 类目确认页

点「确认，下一步」后仍在同一 URL，出现：

| 元素 | 选择器 |
| --- | --- |
| 类目候选 | `.path-name`（选中的那条**没有** `normal` 类；带 `readonly` 的不可选） |
| 品牌 | `#struct-p-20000 .next-select-trigger`（可见实例）→ 选项 `.options-item` |
| 货号 | `input[name="p-13021751"]`（可见实例） |
| 下一步 | 文本为「确认，下一步」的 `button` |

实测本次 AI 给出的候选：
```
家庭/个人清洁工具>>卫浴/置物用具>>足浴盆/足浴桶   ← 默认选中，取它
家庭/个人清洁工具>>家务/地板清洁用具>>水桶
婴童用品>>宝宝卫浴用品>>浴盆/浴桶
```

品牌下拉里该类目**只有一个授权品牌**：`摩狮度（户外运动）`（value `-11957505420`）；
下拉底部还有「没找到对应品牌？申请品牌类目授权」→ `//zhaoshang.tmall.com/common/brandList.htm`。

填完这两项，「确认，下一步」变可用；点击后进入商品表单。

### ⑥ 商品表单

URL 形如：
```
https://sell.publish.tmall.com/tmall/publish.htm
  ?catId=50011674
  &kp={"p-20000":{"value":-11957505420,"text":"摩狮度（户外运动）"},"p-13021751":"FB001"}
  &fromAIImage=true&fromAIPublish=true&newRouter=1&paramCacheId=…
```

四个分区是页面内锚点：`li.next-menu-item`（选中项带 `.next-selected`）：
**基础信息 / 销售信息 / 物流售后及其他 / 图文描述**。

每个字段是 `div[id^="sell-field-"]`，内含 `.sell-component-info-wrapper-label`（标签）
与 `.sell-component-info-wrapper-required`（必填星号）。

### ⑦ SKU 规格抽屉

| 步骤 | 选择器 / 动作 |
| --- | --- |
| 打开 | `#sell-field-sku` 内文本「+ 创建规格」的 `button` |
| 选模式 | 抽屉内 radio：`自定义填写规格`（标签文本定位，`el.click()` 对 input 无效，要点 label） |
| 加规格值 | 抽屉内 `input[placeholder="输入规格"]` → 真实输入 → **Tab 提交** |
| 再加一行 | `[role=dialog] button.add`（图标按钮，无文本） |
| 提交创建 | 抽屉内文本「确认创建」的 `button` |

提交后表单里出现 SKU 表格 `#sell-field-sku table`，每行 `td` 索引：
`td1`=规格值、**`td2`=价格**、**`td3`=数量**、`td4`=SKU分类（可选）。

### ⑧ 填 SKU 表（本次数据）

| 规格 | 价格 | 数量 |
| --- | --- | --- |
| 10L | 49.9 | 10 |
| 20L | 59.9 | 8 |

`#sell-field-quantity` 会自动汇总（18），`#sell-field-price`（一口价）需要手工填其中一个 SKU 价格
（49.9），规则提示「商品价格应是销售属性表中库存不为0的SKU价格之一」。

### ⑨⑩ 上架时间与提交

| 项 | 值 |
| --- | --- |
| `#sell-field-shelfTime` | radio ×3：立刻上架 / 定时上架 / **放入仓库**（默认选中第 3 个） |
| `#sell-field-tmDeliveryTime` | radio ×4：今日发 / **48小时**（默认）/ 大于48小时 / 固定发货时间 |
| 提交按钮 | 页面底部文本「提交」的 `button` |
| 成功页 | `https://sell.publish.tmall.com/tmall/success.htm?isSuccess=true&primaryId=<itemId>&isEdit=false&auctionStatus=-5&sellerId=…` |

`auctionStatus=-5` = 仓库中。

### ⑪ 读回

```
我的商品 → 仓库中：https://myseller.taobao.com/home.htm/SellManage/in_stock?current=1&pageSize=20
按商品ID搜索后 URL 追加：&queryItemId=<itemId>
编辑商品：https://sell.publish.tmall.com/tmall/itemEdit.htm?itemId=<itemId>
```

搜索要点：页面上有多个输入框，**商品ID 搜索框的 placeholder 是「多个ID以逗号分隔」**，
且需要先把筛选维度切到「商品ID」（页面上的 `商品ID` 文本）。

---

## 3. 必填项清单（提交前必须满足）

| 字段 | id | 本次取值 | 说明 |
| --- | --- | --- | --- |
| 1:1主图 | `mainImagesGroup` | 5 张（多图上传自动分配） | 1:1，≤5 张；见第 2 节 ③ |
| 商品标题 | `title` | 见第 4 节 | ≤60，汉字按 2 计 |
| 商品属性 | `keyProp` | 材质/适用人群/折叠功能/风格 | 见第 4 节 |
| 品牌 | `p-20000` | 摩狮度（户外运动） | 由类目页带入 |
| 货号 | `p-13021751` | 模板「商品编码」 | 由类目页带入 |
| 产品确认 | `productConfirm` | 勾选 | 「已确认产品信息准确无误」 |
| 一口价 | `price` | 模板价格 | 必须是某个有库存 SKU 的价格 |
| 商品数量 | `quantity` | 模板库存 | SKU 模式自动汇总；单规格时手填 |
| 上架时间 | `shelfTime` | 放入仓库 | 默认即选中 |
| 发货时间 | `tmDeliveryTime` | 48小时 | 默认即选中 |
| 提取方式 | `tmExtractWay` | 邮寄（勾选） | **必须手动勾**，默认两个都不勾；勾选后会出现运费相关选项 |
| 发货地 | `location` | 大陆及港澳台 + 单一发货地 + 省/市 | **两组单选＋三级级联，必须点到「市」** |
| 返点比例 | `auctionPoint` | 0.5 | 默认 0.5，范围 0.5%–1.5% |
| 宝贝详情 | `descRepublicOfSell` | 12 张（多图上传自动分配） | 不填会由主图自动填充 |

---

## 4. PDD 模板 → 天猫字段映射

| PDD 模板项 | 模板值 | 天猫字段 | 本次取值 |
| --- | --- | --- | --- |
| 商品编码 | FB001 | 货号 `p-13021751` + 商家编码 `#sell-field-outerId` | FB001 / FB001 |
| 商品标题 | 可折叠泡脚桶 家用便携 | `#sell-field-title` | 同左（21/60） |
| 目标类目 | 家庭/个人清洁工具 > 卫浴/置物用具 > 沐浴桶/沐浴盆 | AI 候选 → 类目 | 家庭/个人清洁工具>>卫浴/置物用具>>足浴盆/足浴桶（catId 50011674） |
| 商品品牌 | 空 | 品牌 `p-20000` | 摩狮度（户外运动）（店铺唯一授权） |
| 材质 | 塑料 | `p-20021` | 塑料（可选值含 ABS塑料/PP塑料/PVC/不锈钢/塑料/木…） |
| 适用人群 | 成人 | `p-664465053` | 成人（儿童/成人/老年人/通用） |
| 是否可折叠 | 可折叠 | `p-9167449` | 可折叠（可折叠/不可折叠/半折叠） |
| 规格清单 容量 | 10L / 20L | `#sell-field-sku` 规格值 | 10L / 20L |
| 拼单价/单买价 | 39.9/49.9、49.9/59.9 | `#sell-field-price` + SKU 行价格 | 取**单买价**：49.9 / 59.9 |
| 库存 | 10 / 8 | SKU 行数量 | 10 / 8（汇总 18） |
| 规格编码 | FB10L / FB20L | 未映射 | 天猫 SKU 行未找到对应编码列，本次留空 |
| 轮播图 1 | foot-bath-main.png | 1:1主图 `mainImagesGroup` | AI 上传 1 张（自动裁 3 张） |
| 详情图 1 | foot-bath-scene.png | 宝贝详情 `descRepublicOfSell` | 本次用 AI 生成的那 1 张；模板详情图未再传 |
| 发货承诺 | 48小时发货及揽收 | 发货时间 `tmDeliveryTime` | 48小时 |
| 7天无理由 / 正品发票 / 假一赔十 | 是/否/否 | `warrant` / `invoice`（默认隐藏） | 未设置，沿用后台默认 |
| 满2件折扣 | 9.5 | `multiDiscountPromotion`（隐藏） | 未设置 |
| 运费模板 | 新疆西藏不配送默认模板 | `tmExtractWay` 下的运费方式 | 勾选「邮寄」后才出现：卖家承担运费（默认，等于包邮）/ 买家承担运费 / 使用运费模板 / 自定义运费 |
| 参考价 | 101 | **无对应字段** | — |

---

## 5. 校验与失败处理

提交时后台会返回 `错误 (N)` 列表（页面顶部「优化建议 / 错误 / 建议」面板）。
**先读错误再决定重试**，不要盲目重复点提交：

```js
const errCount = (document.body.innerText.match(/错误 \((\d+)\)/) || [])[1] || '0';
// 逐字段找带错误的容器
for (const root of document.querySelectorAll('[id^="sell-field-"]')) {
  if (/必填项未填|必填项不能为空|不合法/.test(root.innerText)) { /* 该字段未通过 */ }
}
```

本次实际遇到的两次拦截：
1. `物流售后及其他 1 发货地 必填项未填` —— 只选了「大陆及港澳台」，没选「单一发货地/多发货地」；
2. 选了模式后仍报 `必填项不能为空` —— 省份级联只点到「广东」没点「深圳」。

失败后**表单不会丢**，补完直接再点「提交」即可。

其他阻断点：
- 未保存表单导航会弹 `beforeunload`，需 `dialog{action:"accept"}`。
- **切换类目会弹确认框**：「是否切换类目？切换类目可能将导致已填写内容的丢失？ 确定/取消」，
  必须点「确定」才真正切换；而且**它会清空已填的货号**，所以货号要在切完类目之后再填，并回读校验。
- **单规格商品的「商品数量」会被重置**。没有 SKU 时 `#sell-field-quantity` 需要手填；
  它会在后续操作中被清空，因此**数量/一口价要放在最后填**，提交前再回读一次。
- 页面加载 `baxiaCommon.js`（阿里霸下风控）；本次全程未触发验证码或滑块。
- 提交成功后有「商品预检中，预计 15–45 分钟」，预检期间不建议编辑或上架。
- AI 发品页的图片识别会消耗额度，重复跑同一商品请复用已生成的草稿。

---

## 6. 实测耗时（单商品）

**结论：一个商品 ≈ 12 秒。** 关键是把「固定等待」换成「轮询到条件满足」。

| 阶段 | 慢版（固定 sleep） | 快版（条件轮询） |
| --- | --- | --- |
| 1 打开发品页 | 1.2s | 0.4s |
| 2 切以图发品 + 上传 8 图 | 6.0s | 1.5s |
| 3 进 AI 确认页 | 2.0s | 1.5s |
| 4 选类目 + 品牌 + 填货号 | 3.3s | 0.3s |
| 5 进商品表单 | 7.6s | 3.8s |
| 6 填标题 + 编码 + 价格 + 数量 | 1.1s | 0.2s |
| 7 填类目属性 ×N | 10.1s（3 项） | 0.6s（2 项） |
| 8 提取方式=邮寄 | 0.0s | 0.0s |
| 9 发货地级联 | 8.4s | 0.9s |
| 10 提交 → 成功页 | 3.1s | 2.4s |
| **合计** | **56.3s** | **11.5s** |

快版实测产物（商品ID `1090670844229`）逐项核对通过：标题、编码、一口价 90.99、库存 2000、
风格=简约、折叠功能=可折叠、发货地 广东/深圳、主图 5 张、详情 12 张。

### 怎么做到 5 倍提速

1. **禁止固定 `sleep(N)`，改成条件轮询**。这是唯一的大头：慢版每个下拉「点开等 1.5s → 点选项等 1.2s」
   三项属性就烧掉 10s。快版用 200ms 间隔轮询「下拉是否 `aria-expanded=true`」「触发器文本是否变为目标值」，
   通常 1–2 次轮询就通过。
2. **用具体就绪条件代替「等页面渲染」**。慢版进表单后盲等 4s；快版轮询 `#sell-field-title` 出现。
3. **上传后等「确认，下一步」变为 enabled**，而不是等固定秒数。
4. **点不动就重试**：`clickUntil(点击, 条件)` 最多 6 轮，既快又抗抖动。

### 两个必须知道的坑

1. **残留浮层遮罩会吃掉所有真实鼠标点击**。打开过的下拉可能留下一个透明的
   `.next-overlay-backdrop` 盖在全页之上：`document.elementFromPoint()` 返回的是它而不是目标元素，
   于是任何 CDP 真实鼠标点击都打在遮罩上，页面毫无反应（表现为「点了没反应」，很容易误判成选择器错）。
   修复：真实鼠标点击前先按 `Escape` 清遮罩，并确认
   `document.querySelectorAll('.next-overlay-backdrop').length === 0`。
2. **AI 默认选中的类目会变**。同一批图片，有时默认给「足浴盆/足浴桶」，有时给「沐浴桶/沐浴盆」。
   不能假设默认值正确，必须拿商品资料里的「目标类目」去核对 `.path-name`——选中项的特征是
   **没有 `normal` 类**；要切换需用真实鼠标点击（`el.click()` 无效）。


## 7. 本次实跑产物

| 商品ID | 数据来源 | 图片 | 说明 |
| --- | --- | --- | --- |
| `1090661312520` | 泡脚桶示例.xlsx（模板示例） | 1 主图 + 1 详情 | 首次打通；**现已不在仓库/全部/违规列表，原因未查明** |
| `1089615673569` | 同上 | 1 主图 + 1 详情 | 计时跑第一次尝试的产物 |
| `1090666376048` | 同上 | 1 主图 + 1 详情 | 干净计时跑的产物 |
| `1090668216040` | **真实在售商品（紫色泡脚桶）** | **5 主图 + 12 详情** | 标题/编码/价格/库存/属性均取自 `商品资料.xlsx` |
| `1090670844229` | 同上 | 5 主图 + 12 详情 | **快版 11.5s 跑出**，逐项核对通过 |

真实商品那条（`1090668216040`）：

| 项 | 值 |
| --- | --- |
| 标题 | 家用泡脚桶可折叠保温泡脚袋恒温高深过小腿足浴桶便携宿舍泡脚盆（60/60） |
| 货号 / 商家编码 | B2242CZ+0030402 |
| 价格 / 库存 | ¥90.99 / 2000（单规格，未建 SKU） |
| 属性 | 风格=简约、折叠功能=可折叠；**材质留空**（商品实际是「防水布」，但该类目材质选项只有 ABS塑料/PP塑料/PVC/不锈钢/木材等，无匹配项） |
| 图片 | 5 主图 + 12 详情（由 8 张真实图自动分配） |
| 物流 | 提取方式=邮寄、卖家承担运费（默认）、发货地 大陆及港澳台/单一发货地/广东·深圳 |
| 状态 | 仓库中 |

**这些草稿都真实存在于店铺里**，验收后可自行删除；发货地「广东/深圳」是占位，须按店铺实际改。

---

## 8. 脚本清单

可复用脚本在 `verification/taobao-20261006/publish-flow/flow/`（本地工作区，不入库）：

| 文件 | 作用 |
| --- | --- |
| `lib.cjs` | 公共工具：`shown()`、`evaluate`、`clickMarked`、`typeInto`、`navigate`（自动处理 beforeunload） |
| `stage1-upload.cjs` | 进以图发品 → 上传主图 |
| `stage2-category.cjs` | AI 确认页：类目 + 品牌 + 货号 |
| `stage3-enter-form.cjs` | 进入商品表单并侦察字段 |
| `stage4b-fill.cjs` | 标题/商家编码/三个类目属性 |
| `stage5a-sku-explore.cjs` `stage5b-sku-create.cjs` `stage5d-sku-fill.cjs` | 规格抽屉与 SKU 表 |
| `stage6-audit.cjs` `stage7-precheck.cjs` | 必填项审计与补填 |
| `stage8-submit.cjs` `stage8b/8c/8d/8e` | 提交与发货地级联修复 |
| `stage9b-readback.cjs` | 仓库中按商品ID读回 |

截图证据：`stage1-uploaded.jpg`、`ai-form.jpg`、`product-form-top.jpg`、`sku-table.jpg`、
`stage5-sku-filled.jpg`、`success.jpg`、`readback.jpg` 等。

---

## 9. 代码实现

流程已固化为正式实现（0.1.46 开发版）：

| 文件 | 职责 |
| --- | --- |
| `electron/platforms/taobao-publish.ts` | 发品流程本体：常量、页面脚本、纯函数、`TaobaoPublish` 类 |
| `electron/platforms/taobao-adapter.ts` | 组装登录 → 发品 → 读回；已保存过的任务只读回、绝不重复提交 |
| `src/platforms.ts` | `taobao.draftPublishing` 翻为 `true`，界面据此放开「建立任务」 |
| `tests/taobao-publish.test.cjs` | 纯逻辑单测：标题长度、图片落位计划、价格/数量、类目匹配、落位核对 |

### 三条硬规则在代码里的落点

1. **可见实例过滤** —— 所有定位都走 `TaobaoPublish.markVisible()`：先给可见的那一个实例打唯一属性，
   再把该属性选择器交给 `bridge.fill` / `bridge.click`。页面脚本一律注入 `TB_SHOWN`。
2. **真实键盘输入** —— 文本字段统一用 `bridge.fill(selector, value, 'keyboard')`，
   它内部走 CDP `Input.insertText` + `Tab`。扩展的 `fill`（改 DOM value）对 React 受控组件无效。
3. **浮层遮罩清理** —— `closeOverlays()` 在每次真实鼠标点击前按 `Escape` 直到
   `.next-overlay-backdrop` 清零。

### 流程编排与进度步

`TaobaoPublish.run()` 按 `context.step` 分段，映射到 `TaskStep`：

```
打开发品页(resources) → 上传轮播图与详情图(images) → 核对类目与品牌(form)
→ 填写基础信息(basic) → 填写类目属性(basic) → 填写价格与库存(skus)
→ 填写物流与售后(services) → 核对图片落位(images) → 提交保存草稿(save) → 读回草稿(draft_list)
```

### 后端检查项的落点

`identity` / `category` / `brand` / `attributes` / `skus` / `images` / `shipping` 逐项上报；
`freight` 报 `not_applicable`（沿用后台默认「卖家承担运费」，商品资料的运费模板未接入）；
`qualification` 报 `not_applicable`（本流程只保存草稿，不做最终发布审核）。

### 已知边界

- **发货地**商品资料里没有，天猫又必填，当前用 `TAOBAO_DEFAULT_ORIGIN`（广东/深圳）并在检查项里写明，
  接入店铺设置前需运营核对。
- **类目属性选项**按属性名在页面上匹配，类目里没有该选项就跳过并写进检查项说明（如「防水布」），
  不猜近似值。
- **SKU 多规格**：当前实现保存单规格商品；多规格建规格抽屉（`+ 创建规格`）已实地走通，
  但尚未固化成代码。
- **运费模板**：勾选「邮寄」后出现的运费方式已摸清，未接入自动选择。

---

## 10. 商品资料模板（淘宝版）

**拼多多的 Excel 不能用于淘宝。** 两边的发品表单字段不同，硬套会在提交时被后台拦下：

| 差异 | 拼多多模板 | 淘宝模板 |
| --- | --- | --- |
| 价格 | 拼单价 + 单买价两列 | **一口价**一列 |
| 参考价 | 必填（须高于单买价） | **天猫无此字段**，已删除 |
| 满2件折扣 | 有 | **天猫无此字段**（属营销工具，不在发品表单），已删除 |
| 发货承诺 / 7天无理由 / 正品发票 / 假一赔十 | 有 | **本类目发布页没有这些落点**（全文检索均为 -1），已删除 |
| 规格编码 | 规格清单有这一列 | **天猫 SKU 表没有编码列**，已删除 |
| 商家编码 | 无独立栏 | **独立一栏**，可留空回落商品编码 |
| 发货地 | 无 | **必填**，且必须填到「省 / 市」两级 |
| 提取方式 | 无 | 必填：邮寄 / 电子交易凭证 |
| 运费承担 | 运费模板一列 | 卖家承担 / 买家承担（选买家承担才要运费模板） |
| 发货时间 | 发货承诺一句话 | 单选：今日发 / 48小时 / 大于48小时 |
| 上架时间 | 无 | 必填：放入仓库 / 立刻上架 / 定时上架 |
| 返点比例 | 无 | 必填：0.5–1.5，且是 0.5 的整数倍 |
| 图片位 | 轮播图（≤10）+ 详情图（≤50） | **1:1主图（≤5）+ 3:4主图（≤5）+ 详情图（≤20）+ 白底图 + 卖点图** |
| 主图比例 | 1:1 或 3:4 都算主图 | 1:1主图必须 1:1；3:4 是独立图片位 |

### 文件与生成

| 项 | 位置 |
| --- | --- |
| 生成脚本 | `scripts/build-taobao-template.py`（可重新生成，改字段只改这里） |
| 空白模板 | `resources/templates/淘宝商品资料模板.xlsx` → 同步到 `运营资料/` |
| 填写示例 | `resources/templates/淘宝商品资料示例.xlsx`（真实紫色泡脚桶 + 内嵌 25 张图） |
| 模板版本 | `模板版本 = 4`，导入器据此走淘宝分支（`templateFormat = 淘宝运营模板 v4`） |

模板细节：
- 固定取值集合的栏位都做了**数据验证下拉**（提取方式 / 运费承担 / 发货时间 / 上架时间 / 返点比例 / 是否可折叠 / 是否测试素材）。
- 标黄只给「必填 / 软件必填」；选填项是浅灰，「图片清单」的「图片」列才是插图的黄格。
- 「其他类目属性」需运营按后台该类目实际下发的属性填写；属性名要与后台完全一致（发品流程按精确匹配找字段）。

重新生成示例（需要图片目录）：

```sh
python3 scripts/build-taobao-template.py verification/taobao-20261006/publish-flow/real-images
```

### 导入器改动

- `模板版本 4` 走淘宝分支：规格清单表头认「一口价（元）」，图片清单认 5 个淘宝图片位。
- 导入时一口价**同时写进 `group` 与 `single`**，这样拼多多侧的价格逻辑不用改、淘宝侧取 `single` 当一口价。
- 淘宝商品在 `Product.taobao` 上带一组设置（发货地省/市、提取方式、运费承担、发货时间、上架时间、返点比例），
  拼多多商品该字段为 `undefined`。
- `problems()` 按平台分支：淘宝商品不再要求参考价与满件折扣，改为校验发货地/提取方式/发货时间/上架时间/返点比例，
  图片上限也按平台走。

### 顺带修掉的一个导入缺陷

`openpyxl` 等工具写 xlsx 时会把中文写成 `&#39033;&#30446;` 这样的数字字符引用，
而导入器的 XML 解析器原先不解码数字实体 —— 结果整份表格的「项目 / 填写值」表头全读不出来，
直接报「无法识别此表格」。已加 `htmlEntities: true`，Excel/WPS 的字面 UTF-8 与其它工具的数字实体都能读。

### 还没接进模板的

- **运费模板名**已能填写，但自动流程还没接「买家承担 → 使用运费模板 → 选模板」这一段。
- **3:4主图 / 白底图 / 卖点图**模板预留了图片位并能导入，但发品流程暂不自动填写（后台可分别由 1:1 主图裁剪生成）。
