import type { Task, TaskStep } from './types';

export const executionSteps: { step: TaskStep; label: string }[] = [
  { step: 'connect', label: '连接浏览器' }, { step: 'login', label: '登录并核对店铺' },
  { step: 'resources', label: '检查商品图片' }, { step: 'form', label: '打开商品填写页' },
  { step: 'basic', label: '填写基本资料' }, { step: 'skus', label: '填写规格、价格和库存' },
  { step: 'services', label: '设置发货和售后' }, { step: 'images', label: '上传商品图片' },
  { step: 'pre_save', label: '核对填写结果' }, { step: 'save', label: '保存后台草稿' },
  { step: 'saved_fields', label: '核对已保存资料' }, { step: 'draft_list', label: '确认草稿箱结果' },
];

export const taskIsActive = (task: Task) => task.status === 'running' || task.agentDiagnosis?.status === 'running';
export const taskIsHistory = (task: Task) => task.status !== 'prepared' && !taskIsActive(task);
export const taskStatusLabel = (task: Task) => task.agentDiagnosis?.status === 'running' ? '正在处理页面异常' : ({
  prepared: '等待执行', running: '正在执行', awaiting_user: '需要处理', succeeded: '草稿已保存', failed: '执行失败', uncertain: '保存结果待核对',
} as const)[task.status];

export function batchProgress(all: Task[], ids: string[]) {
  const byId = new Map(all.map(task => [task.id, task]));
  const tasks = [...new Set(ids)].flatMap(id => { const task = byId.get(id); return task && !task.clearedAt ? [task] : []; });
  const active = tasks.find(taskIsActive);
  const blocked = tasks.find(task => !['succeeded', 'prepared', 'running'].includes(task.status));
  const current = active || blocked || tasks.find(task => task.status === 'prepared') || tasks.at(-1);
  const completed = tasks.filter(task => task.status === 'succeeded').length;
  return { tasks, current, active, completed, finished: tasks.length > 0 && completed === tasks.length };
}

export function continuationIds(tasks: Task[], current: Task): string[] {
  const index = tasks.findIndex(task => task.id === current.id);
  if (index < 0 || current.status === 'succeeded' || taskIsActive(current) || current.clearedAt) return [];
  return [current, ...tasks.slice(index + 1).filter(task => task.status === 'prepared' && task.shopId === current.shopId && !task.clearedAt)].map(task => task.id);
}

export function stepProgress(task: Task, step: TaskStep) {
  const timing = task.timings?.filter(item => item.step === step).at(-1);
  return timing || null;
}
