import { describe, expect, it } from 'vitest';
import { extractResponsePreview } from '../src/utils/requestLogPreview.js';

describe('request log preview utils', () => {
  describe('extractResponsePreview', () => {
    it('summarizes html error pages instead of storing raw markup', () => {
      const html = `<!DOCTYPE html>
<html lang="en-US">
  <head>
    <title>innies.computer | 504: Gateway time-out</title>
  </head>
  <body>
    <h1>Gateway time-out <span>Error code 504</span></h1>
    <div>Performance &amp; security by Cloudflare</div>
  </body>
</html>`;

      expect(extractResponsePreview(html)).toBe('Cloudflare innies.computer | 504: Gateway time-out');
    });

    it('keeps non-html plain text previews unchanged', () => {
      expect(extractResponsePreview('upstream timeout')).toBe('upstream timeout');
    });

    it('extracts text from sse payloads', () => {
      const payload = [
        'event: response.output_text.delta',
        'data: {"delta":"hello"}',
        '',
        'event: response.output_text.delta',
        'data: {"delta":"world"}'
      ].join('\n');

      expect(extractResponsePreview(payload)).toBe('hello\nworld');
    });
  });
});
