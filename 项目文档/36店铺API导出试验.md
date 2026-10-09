# 店铺API导出试验

日期：2026-10-09。结论：当前Mandla店铺已完成接口读取在售列表、三件商品含图Excel导出及重新导入核对，具备接入App的可行性。0.1.63正式软件的导出入口仍使用原DOM流程；此次没有重新发包或改变在线更新版本。

## 实测结果

通过已登录商家后台的页面客户端`window.__mms.fetch.post`调用只读查询，浏览器继续负责登录和店铺身份。61件在售商品分7页读取，用时1.954秒，编号唯一、数量与当前后台在售总数一致。

三件样本使用当前在售版本，不读取未保存编辑副本。模板和Excel图片写入复用项目现有导出器，未另建文件格式。

| 样本 | SKU数 | 主图/详情图/已有规格图位置 | 接口资料读取 | 完整含图Excel导出 | 导出后回导核对 |
| --- | ---: | --- | ---: | ---: | --- |
| 成人泡澡桶 | 6 | 8 / 14 / 6 | 0.447秒 | 1.282秒 | 通过；库存为1991、1997、2000、1997、2000、0 |
| 泡脚桶 | 1 | 10 / 25 / 0 | 0.533秒 | 1.390秒 | 通过；保留来源商品编码及功能、风格属性 |
| 儿童泡澡桶 | 4 | 10 / 16 / 4 | 0.430秒 | 1.143秒 | 通过；已有四个SKU及规格图绑定保留 |

完整导出计时包含四个查询、原图下载和含图Excel生成，不含重新导入自检。三个文件分别约4.8MB、5.3MB、3.5MB；重复图片按地址复用，位置仍分别保留。此前同一六规格样本的两次API导出为1.530秒和1.512秒。

六规格样本的原`ShopCollector.readGoods`真实对照为4.643秒，其中首次开始图片下载在3.720秒。API资料读取约0.45–0.50秒，主要节省打开、重载编辑页及DOM读取时间。此次完整导出节省约67%–72%；这是同机单样本对照，受网络、图片数量和CDN缓存影响，不能直接作为批量或其他店铺的耗时保证。

回导断言覆盖标题、商品编码、类目、品牌/材质/人群/折叠属性、更多属性值、参考价、发货文案、运费名称、三项售后开关、满件折扣、每个SKU的名称和值、两种价格、实际库存及规格编码。图片对照使用图片字节SHA256，分别核对每个规格图绑定、主图与详情图顺序。

与DOM对照，基本资料、SKU价格库存编码、规格图及主图一致，详情图片的来源地址和顺序一致。DOM详情地址带`imageView2/2/w/1700/q/85`变换，API使用原始记录地址，两者下载字节不相同；API文件的回导图片字节已与本次下载的原图一致性核对，未把两种CDN版本的不同摘要误判为缺图。API还读到了旧DOM样本漏读的三个售后开关和9.9折设置。

## 已确认的只读链路

| 用途 | POST路径 | 当前请求与返回要点 |
| --- | --- | --- |
| 在售列表 | `/vodka/v2/mms/query/display/mall/goodsList` | 当前页面请求为`pre_sale_type:4, shipment_time_type:3, is_onsale:1, sold_out:0, out_goods_sn_gray_flag:true, page, size:10`；返回`total`及`goods_list` |
| 数量核对 | `/vodka/v2/mms/query/display/mall_goods/count` | 当前`excluded_goods_type_list:[112]`；返回`on_sale_num`等状态数量 |
| 在售商品详情 | `/glide/v2/mms/query/commit/on_shop/detail` | 传`goods_id`，取得实际在售`goods_commit_id`、类目路径、`skus`、`carousel_gallery`与`detail_gallery` |
| 已选商品属性 | `/draco-ms/mms/query-goods-property` | 传`goods_id`，读取`goods_properties[].name`与`values[]`；本次支持独立单值属性 |
| 详情图片核对 | `/glide/forward/gorse/mms/goods/decoration/commit/query/V2` | 传在售详情返回的`goods_id`和`goods_commit_id`，核对`floor_list[].content_list[].img_url` |
| 运费名称 | `/express_inf/cost_template/get_one` | 传`sourceKey:MMS_GOODS`和在售商品的`costTemplateId`，核对返回编号并读取名称 |

这些为当前商家页面内部接口，复用页面正常客户端生成请求上下文，不保存Cookie或固定校验值。商品列表的促销价格不能代替SKU原价，导出采用在售详情中的`multi_price`和`price`，单位为分。库存采用各SKU的实际`quantity`，不使用新草稿的`quantity_delta`语义。来源没有商品编码时保留既有`PDD-商品ID`规则。

正常点击编辑入口时，旧流程会请求`create_by_sn`取得或复用编辑副本；API采集使用`on_shop/detail`取得在售版本编号，可以省去这一步。本轮API导出网络记录仅有查询，没有保存、改库存或提交上架；试验前后`on_sale_num:61`、`editing_num:3`、`commit_num:5`的计数一致。

## 接入范围与后续验收

试验脚本校验店铺和子账号、在售状态、商品编号与标题、SKU唯一性、非负整数库存、分单位金额、详情图片双接口顺序、图片地址和大小。导出后重新导入逐项断言，不以接口HTTP 200或生成文件作为完整通过的依据。

当前仅三件普通商品、最多两种规格、独立单值属性和纯图片详情得到验证。复杂/多值属性、带文字/视频/其他装修楼层、其他店铺、空列表、读取途中商品变化、大批量限流、登录失效、取消及App多件ZIP仍需验收。试验未接入UI或改变正式包，也未在Windows/Edge重复此次导出试验。

接入时复用现有店铺身份核对、导出队列、图片下载校验、Excel/ZIP写入、取消及失败报告。API完整性未确认时明确报缺项，不按列表汇总库存分摊SKU，不用待编辑草稿代替在售商品，不静默转入编辑写入接口。

## 本机验证文件

私有数据、脚本和文件位于已忽略的`verification/shop-api-export-20261009/`，未进入公开仓库或安装包：

- `api-sale-list.json`：61件完整在售列表与计时。
- `probe-export.cjs`：四查询读取、模板导出、回导断言。
- `api-export-*.json`、`API-*-含图导出.xlsx`：三件商品导出与逐字段核对结果。
- `dom-export-result.json`、`DOM对照导出.xlsx`：原源码DOM真实对照。
- `comparison.json`：字段、SKU、主图及详情来源顺序对照与计时。
- `api-export-network.json`、`final-counts.json`：只读调用记录与前后数量核对。

当前读不到的属性必填标记没有作为源字段验证，实际发布时仍以目标店铺当前类目模板要求为准。没有将接口试验写成正式App功能或长期稳定性保证。
