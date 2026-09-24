import { get_encoding } from 'tiktoken';

let _enc: ReturnType<typeof get_encoding> | null = null;

export function getEncoder() {
  if (!_enc) {
    _enc = get_encoding('cl100k_base');
  }
  return _enc;
}

export function countTokens(text: string): number {
  return getEncoder().encode(text).length;
}

export function freeEncoder(): void {
  _enc?.free();
  _enc = null;
}
