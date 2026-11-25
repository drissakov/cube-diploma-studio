export function blankCopies(count = 1, fields = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    throw new Error('Введите количество бланков целым числом от 1 до 500.');
  }
  return Array.from({ length: count }, () => ({ ...fields, name: '' }));
}
