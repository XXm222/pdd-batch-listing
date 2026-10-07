import type { ReactNode } from 'react';
import { Modal } from './components';

export function TemplateDownload({
  onClose,
  actions,
}: {
  onClose: () => void;
  actions: ReactNode;
}) {
  return (
    <Modal
      title="模板下载"
      subtitle="商品资料、规格清单与图片清单各一页。"
      onClose={onClose}
      footer={
        <>
          <span className="footer-note">一份表格对应一件商品</span>
          {actions}
        </>
      }
    >
      <div className="modal-body template-body">
        <h3>填写商品和不同款式</h3>
        <p>
          “下载 Excel
          模板”提供空白表格，“下载填写示例”提供带示例数据和图片的参考文件。在商品资料页填写黄色格。规格清单一行填一种，比如“紫色＋大号”，每行分别填价格和库存。“区分方式”填颜色、尺寸或容量，“具体选项”填紫色、大号或20L。只有颜色可选时，第二组留空；商品没有可选款式时，两组都可留空。编码和图片可选填。
        </p>
        <p>
          表格预留 20 行，更多组合可复制最后一行继续填写。本机每件最多读取 100
          行，具体店铺类目限制执行前核验。
        </p>
        <h3>只交一个 Excel</h3>
        <p>
          图片较多时，先填写文字资料并导入
          App，在识别结果里批量添加轮播图、详情图和规格图，再点击“导出当前商品
          Excel”。系统会自动把图片插入对应表格，生成一份可直接分享和重新导入的 Excel。
        </p>
        <p>
          图片直接保存在表格中，无需另外提供图片文件夹或填写文件名。图片清单每行插入一张实际图片，第一张轮播图为主图；规格图放在对应组合行的规格图格内。
        </p>
        <p>
          推荐 Excel/WPS 普通浮动图片，图片左上角放在对应格内，一格一张，保存为 .xlsx 后上传。也支持
          WPS DISPIMG 单元格图片；不支持的图片格式会提示转换。
        </p>
        <h3>保存后选择店铺</h3>
        <p>
          同商品保持同一商品编码。重复导入时可以核对变化，选择更新已有资料或跳过。保存后勾选商品，再选择或添加店铺。
        </p>
        <p>批量商品可同时上传多份 Excel。“选择文件夹”入口目前待开发，请使用单文件 Excel 导入。</p>
        <div className="quiet-note">模板无需填写店铺和后台链接。</div>
      </div>
    </Modal>
  );
}
