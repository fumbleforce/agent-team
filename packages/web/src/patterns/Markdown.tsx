import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';
import { cx } from '../ui';
import '../ui/prose.css';

const POLICY = {
  ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'],
  ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'align', 'type', 'checked', 'disabled', 'start'],
  ALLOW_DATA_ATTR: false,
};
let hooked = false;

// Markdown to HTML that is safe to insert: parsed by marked, then reduced by DOMPurify to a short list of tags and attributes.
// Links open in a new tab without a referrer. This function is the only source of injected HTML in the app.
export function renderMarkdown(source: string): string {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', node => {
      if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noreferrer noopener'); }
      if (node.tagName === 'INPUT' && node.getAttribute('type') !== 'checkbox') node.remove();
    });
  }
  if (!DOMPurify.isSupported) return escapeHtml(source);
  return DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: true }), POLICY);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

export function Markdown({ children, size = 'body', className }: { children: string; size?: 'body' | 'small'; className?: string }) {
  const html = useMemo(() => renderMarkdown(children), [children]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: the one sanctioned injection point; the markup comes from renderMarkdown, which sanitizes it.
  return <div className={cx('prose', size === 'small' && 'prose-small', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
