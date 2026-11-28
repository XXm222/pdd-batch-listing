#!/usr/bin/env python3
"""把回扒得到的 JSON + 原图组装成淘宝运营模板 Excel。

配套 scripts/pull-item.mjs 使用：
    ego-browser nodejs < scripts/pull-item.mjs      # 产出 /tmp/tb-pull-<id>/
    python3 scripts/build-excel-from-item.py <id>   # 产出 /tmp/tb-pull-<id>/商品资料-<id>.xlsx

只用模板本身的版式（不新建 sheet），这样导回去时 importer 一定能读。
"""
import json
import os
import re
import shutil
import sys

from openpyxl import load_workbook
from openpyxl.drawing.image import Image as XLImage
from PIL import Image as PILImage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(ROOT, "resources", "templates", "淘宝商品资料模板.xlsx")


def normalize_images(work):
    """alicdn 实际返回 webp，openpyxl 会按真实格式登记 mime；统一转成真 JPEG。"""
    src_dir = os.path.join(work, "img")
    out_dir = os.path.join(work, "img-jpg")
    os.makedirs(out_dir, exist_ok=True)
    manifest = json.load(open(os.path.join(work, "manifest.json")))
    kept = []
    for item in manifest:
        src = os.path.join(src_dir, item["file"])
        dst = os.path.join(out_dir, item["file"])
        im = PILImage.open(src)
        w, h = im.size
        if w < 200 or h < 200:
            continue
        if im.mode in ("RGBA", "P", "LA"):
            rgba = im.convert("RGBA")
            bg = PILImage.new("RGB", im.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.split()[-1])
            im = bg
        else:
            im = im.convert("RGB")
        im.save(dst, "JPEG", quality=92)
        item["w"], item["h"] = w, h
        kept.append(item)
    return kept


def fill_info(ws, data):
    """商品资料页：按「项目」名匹配填写值。"""
    category = (data.get("category") or "").replace("当前类目", "").replace("切换类目", "").strip()
    category = re.sub(r"\s*>>\s*", " > ", category)
    values = {
        "商品编码": data.get("code") or "",
        "商家编码": data.get("outerId") or "",
        "商品标题": data.get("title") or "",
        "目标类目": category,
        "商品品牌": data.get("brand") or "",
        "发货地省份": (data.get("taobao") or {}).get("originProvince") or "广东",
        "发货地城市": (data.get("taobao") or {}).get("originCity") or "深圳",
        "提取方式": "邮寄",
        "运费承担": "卖家承担",
        "发货时间": "48小时",
        "上架时间": "放入仓库",
        "返点比例（%）": "0.5",
    }
    filled = 0
    for row in ws.iter_rows(min_row=1, max_row=ws.max_row):
        key = row[0].value
        if isinstance(key, str) and key in values:
            row[1].value = values[key]
            filled += 1
    return filled


def fill_skus(ws, data):
    """规格清单页：一行一个 SKU。模板无「规格编码」列，SKU 级编码不写。"""
    start = 5
    rows = data.get("sku") or []
    for i, sku in enumerate(rows):
        r = start + i
        props = [p for p in (sku.get("props") or []) if p]
        if props:
            ws.cell(row=r, column=1, value="颜色")
            ws.cell(row=r, column=2, value=props[0])
        try:
            ws.cell(row=r, column=5, value=float(sku["price"]))
        except (TypeError, ValueError):
            pass
        try:
            ws.cell(row=r, column=6, value=int(float(sku["qty"])))
        except (TypeError, ValueError):
            pass
    return len(rows)


def fill_images(ws, manifest, work):
    """图片清单页：把图片嵌进「图片」列对应行。"""
    row_of = {}
    for r in range(5, ws.max_row + 1):
        kind, order = ws.cell(row=r, column=1).value, ws.cell(row=r, column=2).value
        if isinstance(kind, str) and isinstance(order, int):
            row_of[(kind, order)] = r
    placed = 0
    for item in manifest:
        kind = "1:1主图" if item["kind"] == "main" else "详情图"
        r = row_of.get((kind, item["order"]))
        if not r:
            continue
        path = os.path.join(work, "img-jpg", item["file"])
        scale = 120 / max(item["w"], item["h"])
        img = XLImage(path)
        img.width = int(item["w"] * scale)
        img.height = int(item["h"] * scale)
        ws.add_image(img, f"C{r}")
        ws.row_dimensions[r].height = max(90, img.height * 0.75)
        placed += 1
    ws.column_dimensions["C"].width = 22
    return placed


def main():
    if len(sys.argv) < 2:
        print("用法: python3 scripts/build-excel-from-item.py <itemId>")
        return 1
    item_id = sys.argv[1]
    work = os.path.join("/tmp", f"tb-pull-{item_id}")
    data = json.load(open(os.path.join(work, "item.json")))

    manifest = normalize_images(work)
    wb = load_workbook(TEMPLATE)
    info = fill_info(wb["商品资料"], data)
    skus = fill_skus(wb["规格清单"], data)
    images = fill_images(wb["图片清单"], manifest, work)

    out = os.path.join(work, f"商品资料-{item_id}.xlsx")
    wb.save(out)
    print(
        json.dumps(
            {
                "out": out,
                "kb": os.path.getsize(out) // 1024,
                "info": info,
                "skus": skus,
                "images": images,
                "skipped": len(json.load(open(os.path.join(work, "manifest.json")))) - images,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
