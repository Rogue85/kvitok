import { convert } from 'html-to-text';
import sanitizeHtml from 'sanitize-html';

const BASE_TAGS = [
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote',
  'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'hr', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
];

/** HTML of an operator reply: only safe formatting, links open in a new window. */
export function sanitizeOperatorHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: BASE_TAGS,
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
  });
}

/**
 * HTML of an incoming email. Scripts, style expressions and handlers are stripped;
 * external images are not loaded (tracking pixels): src moves to data-blocked-src, the UI shows them on request.
 */
export function sanitizeInboundHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [...BASE_TAGS, 'img', 'font', 'center', 'small', 'big', 'sub', 'sup', 'caption', 'colgroup', 'col', 'tfoot'],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['alt', 'width', 'height', 'data-blocked-src', 'data-cid'],
      td: ['colspan', 'rowspan', 'align', 'valign'],
      th: ['colspan', 'rowspan', 'align', 'valign'],
      table: ['width', 'border', 'cellpadding', 'cellspacing'],
      font: ['color'],
      '*': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedStyles: {
      '*': {
        color: [/^#?[0-9a-z(),.\s%]+$/i],
        'background-color': [/^#?[0-9a-z(),.\s%]+$/i],
        'text-align': [/^(left|right|center|justify)$/],
        'font-weight': [/^(bold|normal|\d{3})$/],
        'font-style': [/^(italic|normal)$/],
        'text-decoration': [/^[a-z\s-]+$/],
      },
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
      img: (tagName, attribs) => {
        const src = attribs.src ?? '';
        const next: Record<string, string> = { alt: attribs.alt ?? '' };
        if (src.startsWith('cid:')) {
          next['data-cid'] = src.slice(4);
        } else if (/^https?:/i.test(src)) {
          next['data-blocked-src'] = src;
        }
        if (attribs.width) next.width = attribs.width;
        if (attribs.height) next.height = attribs.height;
        return { tagName, attribs: next };
      },
    },
  });
}

export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
    ],
  }).trim();
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text → HTML with paragraphs (for notes and replies typed without formatting). */
export function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
