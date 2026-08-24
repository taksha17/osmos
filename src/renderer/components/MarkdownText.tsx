import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

marked.setOptions({ breaks: true, gfm: true });

type MarkdownTextProps = {
  readonly text: string;
  readonly className?: string;
};

export function MarkdownText({ text, className }: MarkdownTextProps) {
  const html = useMemo(() => {
    try {
      const raw = marked.parse(text, { async: false }) as string;
      return DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: [
          'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'pre', 'code',
          'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead',
          'tbody', 'tr', 'th', 'td', 'hr', 'div', 'span', 'details',
          'summary', 'small', 'sub', 'sup', 'mark', 'abbr', 'cite', 'q',
        ],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'class'],
        ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      });
    } catch {
      return DOMPurify.sanitize(text);
    }
  }, [text]);

  return (
    <span
      className={`markdown-text ${className ?? ''}`.trim()}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
