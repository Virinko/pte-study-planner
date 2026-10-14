export type TemplateSlot = { label: string; reference: string };
export type TemplateMatch = { slots: TemplateSlot[]; error: string };

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalPattern(text: string) {
  return text.split(/(\s+)/).map((part) => /^\s+$/.test(part) ? '\\s+' : escapeRegex(part)).join('');
}

export function extractTemplateSlots(template: string, answer: string): TemplateMatch {
  const source = template.trim().replace(/\*\*(【[^【】]*】)\*\*/g, '$1');
  const placeholders = [...source.matchAll(/\{\{([^{}]*)\}\}|【([^【】]*)】/g)];
  if (!placeholders.length) return { slots: [], error: '请录入完整模板，并用 【】 标出需要默写的部分。' };
  const remainder = source.replace(/\{\{[^{}]*\}\}|【[^【】]*】/g, '');
  if (placeholders.some((item) => item[0].startsWith('{{') && !item[1].trim()) || /\{\{|\}\}|【|】/.test(remainder)) {
    return { slots: [], error: '占位符格式不正确，请使用 【】 标出需要默写的部分。' };
  }

  const literals: string[] = [];
  let position = 0;
  for (const placeholder of placeholders) {
    literals.push(source.slice(position, placeholder.index));
    position = placeholder.index + placeholder[0].length;
  }
  literals.push(source.slice(position));
  if (!literals.some((part) => part.trim()) || literals.slice(1, -1).some((part) => !part.trim())) {
    return { slots: [], error: '每两个占位符之间需要有固定的模板文字，才能确定各空位的范围。' };
  }

  const pattern = literals.map(literalPattern).join('([\\s\\S]*?)');
  const matched = new RegExp(`^${pattern}$`, 'iu').exec(answer.trim());
  if (!matched) return { slots: [], error: '这份模板与本篇标准答案不匹配。请保留完整固定文字，只把变化的部分改为 【】。' };
  const slots = placeholders.map((item, index) => ({ label: item[1]?.trim() || item[2]?.trim() || `空位 ${index + 1}`, reference: matched[index + 1].trim() }));
  if (slots.some((slot) => !slot.reference)) return { slots: [], error: '有占位符在标准答案中没有对应内容，请调整模板。' };
  return { slots, error: '' };
}
