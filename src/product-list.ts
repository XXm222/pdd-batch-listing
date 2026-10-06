import { problems } from './domain';
import type { Product } from './types';

export function productList(
  products: Product[],
  search: string,
  filter: string,
  page: number,
  selected: ReadonlySet<string>,
) {
  const query = search.trim().toLowerCase();
  const checked = products.map((product) => ({ product, ready: !problems(product).length }));
  const visible = checked
    .filter(
      ({ product, ready }) =>
        `${product.title} ${product.code}`.toLowerCase().includes(query) &&
        (filter === 'all' || (ready ? 'ready' : 'incomplete') === filter),
    )
    .map(({ product }) => product);
  const pageCount = Math.max(1, Math.ceil(visible.length / 40));
  const currentPage = Math.max(0, Math.min(page, pageCount - 1));
  const rows = visible.slice(currentPage * 40, (currentPage + 1) * 40);
  const readyIds = new Set(checked.filter((item) => item.ready).map((item) => item.product.id));
  return {
    readyCount: readyIds.size,
    visible,
    pageCount,
    currentPage,
    rows,
    readyRows: rows.filter((product) => readyIds.has(product.id)),
    // Selection spans pages and filters; only currently valid saved products can run.
    chosen: products.filter((product) => selected.has(product.id) && readyIds.has(product.id)),
  };
}
