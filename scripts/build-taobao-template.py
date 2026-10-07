#!/usr/bin/env python3
"""生成淘宝（天猫）版商品资料模板与填写示例。

为什么单独做一套：拼多多模板里的「参考价」「满2件折扣」「拼单价/单买价」
在天猫发品表单里没有对应项；而天猫必填的「发货地」「提取方式」「上架时间」
「返点比例」拼多多模板里没有。两套模板不能通用。

用法：
    python3 scripts/build-taobao-template.py [图片目录]

图片目录需含 main-01..05.jpg、detail-01..20.jpg（示例用）。省略时不嵌图。
产物：
    resources/templates/淘宝商品资料模板.xlsx   （空白）
    resources/templates/淘宝商品资料示例.xlsx   （填好并内嵌图片）
"""
import os
import shutil
import sys

from openpyxl import Workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES = os.path.join(ROOT, "resources", "templates")

HEADER_FILL = PatternFill("solid", fgColor="FFF2CC")  # 黄色 = 必须填写
OPTIONAL_FILL = PatternFill("solid", fgColor="F2F4F8")  # 浅灰 = 选填/按类目
TITLE_FONT = Font(bold=True, size=12)
HEADER_FONT = Font(bold=True)
NOTE_FONT = Font(size=9, color="808080")

# 商品资料：项目 / 填写要求 / 填写说明。填写列留空 = 空白模板。
INFO_ROWS = [
    ("模板版本", "4", "无需填写", "固定为 4（淘宝版），无需修改"),
    ("商品编码", "", "软件必填", "用于软件识别，同时作为后台的「货号」。同一商品保持同一编码"),
    ("商家编码", "", "选填", "天猫独立的选填字段；留空则沿用商品编码"),
    ("商品标题", "", "必填", "最多 60 字符，汉字按 2 字符计算"),
    (
        "目标类目",
        "",
        "必填",
        "填写天猫后台的完整类目路径，用 > 分隔，最后一级须与后台类目名一致，"
        "如「家庭/个人清洁工具 > 卫浴/置物用具 > 足浴盆/足浴桶」",
    ),
    (
        "商品品牌",
        "",
        "选店后确认",
        "必须填店铺已获授权的品牌；后台该类目只会列出授权品牌，填错会选不中。"
        "不要照抄示例里的品牌名",
    ),
    ("材质", "", "按类目", "按后台该类目的实际选项填写；后台没有对应选项就留空，不要填近似值"),
    ("适用人群", "", "按类目", "按后台选项填写：儿童 / 成人 / 老年人 / 通用"),
    ("是否可折叠", "", "按类目", "可折叠 / 不可折叠 / 半折叠"),
    ("发货地省份", "", "必填", "天猫必填，且必须填到市一级，如「广东」"),
    ("发货地城市", "", "必填", "如「深圳」。只填省不填市，提交会报「必填项未填」"),
    ("提取方式", "邮寄", "必填", "邮寄（实物）/ 电子交易凭证（虚拟商品）"),
    ("运费承担", "卖家承担", "必填", "卖家承担（等于包邮）/ 买家承担"),
    ("运费模板", "", "选填", "仅在「运费承担=买家承担」时有意义；本版不自动选择模板，需在后台人工确认"),
    ("发货时间", "48小时", "必填", "今日发 / 48小时 / 大于48小时。后台还有「固定发货时间」，需要另填时间，本版不支持"),
    ("上架时间", "放入仓库", "必填", "放入仓库（存草稿）/ 立刻上架 / 定时上架"),
    ("返点比例（%）", "0.5", "必填", "0.5 至 1.5，且必须是 0.5 的整数倍"),
    ("是否测试素材", "否", "选填", "是 / 否。填「是」时该商品只做流程验证"),
]

ATTR_ROWS = [
    ("功能", "", "否", "按后台要求填写名称和值，可在末尾追加行"),
    ("风格", "", "否", "如 简约 / 现代 / 北欧"),
]

SKU_HEADER = [
    "规格一名称",
    "规格一值",
    "规格二名称",
    "规格二值",
    "一口价（元）",
    "库存",
    "规格图",
]

IMAGE_ROWS = (
    [("1:1主图", i + 1, "必填，1:1，推荐 1440x1440，最多 5 张；第一张为主图") for i in range(5)]
    + [("3:4主图", i + 1, "选填，3:4，最多 5 张；本版不自动填写，可在后台由 1:1 主图裁剪") for i in range(5)]
    + [("详情图", i + 1, "选填，最多 20 张；支持长图，宽度建议 ≥1440") for i in range(20)]
    + [("白底图", 1, "选填，800x800 纯白底；本版不自动填写")]
    + [("卖点图", 1, "选填；本版不自动填写")]
)

EXAMPLE = {
    "商品编码": "B2242CZ+0030402",
    "商品标题": "家用泡脚桶可折叠保温泡脚袋恒温高深过小腿足浴桶便携宿舍泡脚盆",
    "目标类目": "家庭/个人清洁工具 > 卫浴/置物用具 > 足浴盆/足浴桶",
    "商品品牌": "Mandla/漫多拉",
    "材质": "防水布",
    "适用人群": "成人",
    "是否可折叠": "可折叠",
    "发货地省份": "广东",
    "发货地城市": "深圳",
    "提取方式": "邮寄",
    "运费承担": "卖家承担",
    "发货时间": "48小时",
    "上架时间": "放入仓库",
    "返点比例（%）": "0.5",
    "发货承诺": "48小时发货及揽收",
    "7天无理由退货": "是",
    "正品发票": "否",
    "假一赔十": "否",
    "是否测试素材": "否",
}
EXAMPLE_SKUS = [("", "", "", "", "90.99", "2000", "")]
EXAMPLE_ATTRS = [("功能", "可折叠", "否"), ("风格", "简约", "否")]


def build(path, images_dir=None, with_example=False):
    wb = Workbook()

    info = wb.active
    info.title = "商品资料"
    info["A1"] = "淘宝（天猫）商品资料"
    info["A1"].font = TITLE_FONT
    info["A2"] = "一份 Excel 对应一件商品，可填写多个 SKU。标黄列需要填写；图片直接插在「图片清单」页。"
    info["A2"].font = NOTE_FONT
    for index, label in enumerate(["项目", "填写值", "填写要求", "填写说明"], start=1):
        cell = info.cell(row=4, column=index, value=label)
        cell.font = HEADER_FONT
    row = 5
    for name, _, requirement, note in INFO_ROWS:
        value = EXAMPLE.get(name, "") if with_example else ("4" if name == "模板版本" else "")
        if name == "模板版本":
            value = "4"
        info.cell(row=row, column=1, value=name)
        cell = info.cell(row=row, column=2, value=value)
        # 只把真正必须填的格子标黄；全部标黄会让运营以为选填项也得凑。
        cell.fill = HEADER_FILL if requirement in ("必填", "软件必填") else OPTIONAL_FILL
        info.cell(row=row, column=3, value=requirement)
        info.cell(row=row, column=4, value=note)
        row += 1
    row += 1
    info.cell(row=row, column=1, value="其他类目属性：只填写该类目实际需要的属性，不重复填写上方已有属性。")
    info.cell(row=row, column=1).font = NOTE_FONT
    row += 1
    for index, label in enumerate(["属性名称", "填写值", "后台必填"], start=1):
        info.cell(row=row, column=index, value=label).font = HEADER_FONT
    row += 1
    attrs = EXAMPLE_ATTRS if with_example else [("", "", ""), ("", "", "")]
    for name, value, required in attrs:
        info.cell(row=row, column=1, value=name)
        info.cell(row=row, column=2, value=value).fill = HEADER_FILL
        info.cell(row=row, column=3, value=required)
        row += 1
    # 需要固定取值集合的栏位一律做成下拉，避免运营手打出后台不存在的值。
    dropdowns = {
        "提取方式": "邮寄,电子交易凭证",
        "运费承担": "卖家承担,买家承担",
        "发货时间": "今日发,48小时,大于48小时",
        "上架时间": "放入仓库,立刻上架,定时上架",
        "返点比例（%）": "0.5,1,1.5",
        "是否可折叠": "可折叠,不可折叠,半折叠",
        "是否测试素材": "是,否",
    }
    for name, options in dropdowns.items():
        row = next((i for i, r in enumerate(INFO_ROWS, start=5) if r[0] == name), None)
        if row is None:
            continue
        rule = DataValidation(type="list", formula1=f'"{options}"', allow_blank=True, showDropDown=False)
        info.add_data_validation(rule)
        rule.add(info.cell(row=row, column=2))

    for column, width in zip("ABCD", (14, 46, 14, 62)):
        info.column_dimensions[column].width = width

    sku = wb.create_sheet("规格清单")
    sku["A1"] = "商品规格清单"
    sku["A1"].font = TITLE_FONT
    sku["A2"] = (
        "一行一个 SKU。一口价与库存必填；单规格商品可留空规格名称和值。"
        "规格图选填，每行在「规格图」格插入一张图片。"
        "天猫 SKU 表没有编码列，所以这里不设「规格编码」栏。"
    )
    sku["A2"].font = NOTE_FONT
    for index, label in enumerate(SKU_HEADER, start=1):
        cell = sku.cell(row=4, column=index, value=label)
        cell.font = HEADER_FONT
    rows = EXAMPLE_SKUS if with_example else [("", "", "", "", "", "", "")]
    for offset, values in enumerate(rows):
        for index, value in enumerate(values, start=1):
            sku.cell(row=5 + offset, column=index, value=value).fill = HEADER_FILL
    for column, width in zip("ABCDEFG", (12, 14, 12, 14, 14, 10, 16)):
        sku.column_dimensions[column].width = width

    pictures = wb.create_sheet("图片清单")
    pictures["A1"] = "商品图片清单"
    pictures["A1"].font = TITLE_FONT
    pictures["A2"] = (
        "每行在「图片」格插入一张图片，左上角放在对应格内，保存为 .xlsx。"
        "不要填文件名，也不要用网络图片链接。"
    )
    pictures["A2"].font = NOTE_FONT
    for index, label in enumerate(["用途", "顺序", "图片", "填写要求"], start=1):
        pictures.cell(row=4, column=index, value=label).font = HEADER_FONT
    for offset, (kind, order, note) in enumerate(IMAGE_ROWS):
        row = 5 + offset
        pictures.cell(row=row, column=1, value=kind)
        pictures.cell(row=row, column=2, value=order)
        pictures.cell(row=row, column=4, value=note)
    for row in range(5, 5 + len(IMAGE_ROWS)):
        # 「图片」列才是要插图的地方，之前一格都没标黄。
        pictures.cell(row=row, column=3).fill = HEADER_FILL
    for column, width in zip("ABCD", (14, 8, 22, 66)):
        pictures.column_dimensions[column].width = width
    for row in range(5, 5 + len(IMAGE_ROWS)):
        pictures.row_dimensions[row].height = 96

    if with_example and images_dir:
        slots = [("1:1主图", [f"main-{i:02d}.jpg" for i in range(1, 6)])]
        slots.append(("详情图", [f"detail-{i:02d}.jpg" for i in range(1, 21)]))
        placed = 0
        for kind, files in slots:
            for offset, name in enumerate(files):
                source = os.path.join(images_dir, name)
                if not os.path.exists(source):
                    raise SystemExit(f"缺少示例图片：{source}")
                row = next(
                    i
                    for i, (k, order, _) in enumerate(IMAGE_ROWS)
                    if k == kind and order == offset + 1
                ) + 5
                picture = XLImage(source)
                picture.width, picture.height = 120, 120
                pictures.add_image(picture, f"C{row}")
                placed += 1
        print(f"已嵌入 {placed} 张示例图片")

    for sheet in wb.worksheets:
        sheet.freeze_panes = "A5"

    wb.save(path)
    print(f"已生成 {os.path.relpath(path, ROOT)}")


def main():
    images_dir = sys.argv[1] if len(sys.argv) > 1 else None
    os.makedirs(TEMPLATES, exist_ok=True)
    blank = os.path.join(TEMPLATES, "淘宝商品资料模板.xlsx")
    example = os.path.join(TEMPLATES, "淘宝商品资料示例.xlsx")
    build(blank)
    if images_dir:
        build(example, images_dir, with_example=True)
    else:
        print("未提供图片目录，跳过示例（示例需要内嵌图片）")
    working = os.path.join(ROOT, "运营资料")
    if os.path.isdir(working):
        for name in ("淘宝商品资料模板.xlsx", "淘宝商品资料示例.xlsx"):
            source = os.path.join(TEMPLATES, name)
            if os.path.exists(source):
                shutil.copy2(source, os.path.join(working, name))
                print(f"已同步到 运营资料/{name}")


if __name__ == "__main__":
    main()
