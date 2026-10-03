/** Pure geometry rules. Rectangles use CSS pixels and no clipping tolerance. */
export function visibilityReason({ rects = [], viewport, ancestors = [], hidden = false, cutOff = '' }) {
  if (hidden) return 'hidden';
  if (!rects.length) return 'no rendered rectangle';
  for (const rect of rects) {
    if (![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) ||
        rect.right <= rect.left || rect.bottom <= rect.top) return 'empty rectangle';
    if (rect.left < 0 || rect.top < 0 || rect.right > viewport.width || rect.bottom > viewport.height) return 'outside viewport';
    for (const clip of ancestors) {
      if ((clip.x && (rect.left < clip.left || rect.right > clip.right)) ||
          (clip.y && (rect.top < clip.top || rect.bottom > clip.bottom))) return 'clipped by ' + clip.name;
    }
  }
  return cutOff;
}

/** Page-side evidence collection. evidenceExpression supplies the pure rule explicitly. */
export function checkEvidence(evidence, reasonFor, root = document, viewport = { width: innerWidth, height: innerHeight }) {
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  const snapshot = (element, rects) => {
    const ancestors = [];
    let hidden = false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || node.hidden || node.inert) hidden = true;
      if (node === element) continue;
      const box = node.getBoundingClientRect();
      ancestors.push({ name: node.tagName.toLowerCase(), x: style.overflowX !== 'visible', y: style.overflowY !== 'visible',
        left: box.left + node.clientLeft, top: box.top + node.clientTop,
        right: box.left + node.clientLeft + node.clientWidth, bottom: box.top + node.clientTop + node.clientHeight });
    }
    let cutOff = '';
    for (const node of [element, ...element.querySelectorAll('*')]) {
      const style = getComputedStyle(node);
      if ((style.overflowX !== 'visible' && node.scrollWidth > node.clientWidth + 1) ||
          (style.overflowY !== 'visible' && node.scrollHeight > node.clientHeight + 1)) {
        cutOff = 'content cut off in ' + node.tagName.toLowerCase();
        break;
      }
    }
    return reasonFor({ rects, viewport, ancestors, hidden, cutOff });
  };
  const textReason = (scope, text) => {
    const walker = root.createTreeWalker(scope, 4);
    const candidates = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!normalize(node.textContent).includes(normalize(text))) continue;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.parentElement.tagName)) continue;
      const range = root.createRange();
      range.selectNodeContents(node);
      candidates.push(snapshot(node.parentElement, [...range.getClientRects()]));
    }
    return { reason: candidates.some(reason => !reason) ? '' : candidates[0] || 'missing visible text', matches: candidates.length };
  };
  const results = evidence.map(item => {
    try {
      if (item.selector) {
        const matches = [...root.querySelectorAll(item.selector)];
        const elements = item.index === undefined ? matches : matches.slice(item.index, item.index + 1);
        if (!elements.length) return { evidence: item, ok: false, reason: 'missing element' };
        const reasons = elements.map(element => snapshot(element, [element.getBoundingClientRect()]) ||
          (item.text ? textReason(element, item.text).reason : ''));
        const reason = reasons.find(Boolean) || '';
        return { evidence: item, ok: !reason, reason, matches: elements.length };
      }
      const { reason, matches } = textReason(root.body, item.text);
      return { evidence: item, ok: !reason, reason, matches };
    } catch (error) {
      return { evidence: item, ok: false, reason: error.message };
    }
  });
  return { ok: results.every(result => result.ok), results };
}

export const evidenceExpression = evidence =>
  '(' + checkEvidence.toString() + ')(' + JSON.stringify(evidence) + ', ' + visibilityReason.toString() + ')';
