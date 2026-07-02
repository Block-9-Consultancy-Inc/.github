export function adfToMarkdown(adfDocument) {
  if (!adfDocument) {
    return '_No Jira description was provided._';
  }

  if (typeof adfDocument === 'string') {
    return adfDocument.trim() || '_No Jira description was provided._';
  }

  const renderedMarkdown = renderAdfBlocks(adfDocument.content || []).trim();
  return renderedMarkdown || '_No Jira description was provided._';
}

export function markdownToSimpleAdf(markdownText) {
  /*
   * Jira comments use Atlassian Document Format. A full Markdown-to-ADF
   * conversion would be heavy for this app, so mirrored GitHub comments are
   * preserved as plain text paragraphs. This is predictable and keeps source
   * links/markers intact.
   */
  const text = markdownText || '';

  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? plainTextWithLinksToAdfInlineNodes(line) : []
    }))
  };
}

function plainTextWithLinksToAdfInlineNodes(text) {
  /*
   * The app generates Jira comments as plain text with source URLs. Jira only
   * renders those as clickable links when the ADF text node has a link mark, so
   * this small parser preserves the simple text format while making URLs real
   * hyperlinks in Jira.
   */
  const nodes = [];
  const urlPattern = /https?:\/\/[^\s)]+/g;
  let lastIndex = 0;
  let match = urlPattern.exec(text);

  while (match) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }

    const url = match[0];
    nodes.push({
      type: 'text',
      text: url,
      marks: [
        {
          type: 'link',
          attrs: {
            href: url
          }
        }
      ]
    });

    lastIndex = match.index + url.length;
    match = urlPattern.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return nodes;
}

export function renderAdfBlocks(nodes, context = {}) {
  return nodes
    .map((node) => renderAdfBlock(node, context))
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n');
}

function renderAdfBlock(node, context = {}) {
  if (!node) {
    return '';
  }

  switch (node.type) {
    case 'blockquote':
      return prefixLines(renderAdfBlocks(node.content || [], context), '> ');
    case 'bulletList':
      return renderAdfList(node, { ...context, ordered: false });
    case 'codeBlock':
      return renderAdfCodeBlock(node);
    case 'doc':
      return renderAdfBlocks(node.content || [], context);
    case 'heading':
      return renderAdfHeading(node);
    case 'orderedList':
      return renderAdfList(node, { ...context, ordered: true });
    case 'panel':
      return renderAdfBlocks(node.content || [], context);
    case 'paragraph':
      return renderAdfInlineContent(node.content || []);
    case 'rule':
      return '---';
    case 'table':
      return renderAdfTable(node);
    default:
      return renderAdfBlocks(node.content || [], context);
  }
}

function renderAdfHeading(node) {
  const level = Math.min(Math.max(node.attrs?.level || 3, 1), 6);
  const headingText = renderAdfInlineContent(node.content || []);
  return `${'#'.repeat(level)} ${headingText}`;
}

function renderAdfList(node, context) {
  const depth = context.depth || 0;
  const startOrder = node.attrs?.order || 1;

  return (node.content || [])
    .map((listItem, index) => {
      const marker = context.ordered ? `${startOrder + index}.` : '-';
      return renderAdfListItem(listItem, marker, depth);
    })
    .filter(Boolean)
    .join('\n');
}

function renderAdfListItem(listItem, marker, depth) {
  const indent = '  '.repeat(depth);
  const nestedIndent = '  '.repeat(depth + 1);
  const renderedChildren = (listItem.content || [])
    .map((child) => {
      if (child.type === 'bulletList') {
        return renderAdfList(child, { ordered: false, depth: depth + 1 });
      }

      if (child.type === 'orderedList') {
        return renderAdfList(child, { ordered: true, depth: depth + 1 });
      }

      return renderAdfBlock(child, { depth: depth + 1 });
    })
    .filter(Boolean);

  if (renderedChildren.length === 0) {
    return `${indent}${marker}`;
  }

  const firstChild = renderedChildren[0].replace(/\n/g, `\n${nestedIndent}`);
  const remainingChildren = renderedChildren
    .slice(1)
    .map((child) => `${nestedIndent}${child.replace(/\n/g, `\n${nestedIndent}`)}`);

  return [`${indent}${marker} ${firstChild}`, ...remainingChildren].join('\n');
}

function renderAdfCodeBlock(node) {
  const language = node.attrs?.language || '';
  const codeText = extractPlainText(node).replace(/```/g, '`` `');
  return `\`\`\`${language}\n${codeText}\n\`\`\``;
}

function renderAdfTable(node) {
  const rows = (node.content || []).map((row) => {
    return (row.content || []).map((cell) => {
      const cellMarkdown = renderAdfBlocks(cell.content || [])
        .replace(/\n/g, '<br>')
        .replace(/\|/g, '\\|');
      return cellMarkdown || ' ';
    });
  });

  if (rows.length === 0) {
    return '';
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => {
    return [...row, ...Array(Math.max(columnCount - row.length, 0)).fill(' ')];
  });
  const header = normalizedRows[0];
  const separator = Array(columnCount).fill('---');

  return [header, separator, ...normalizedRows.slice(1)]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');
}

function renderAdfInlineContent(nodes) {
  return (nodes || []).map((node) => renderAdfInlineNode(node)).join('');
}

function renderAdfInlineNode(node) {
  if (!node) {
    return '';
  }

  if (node.type === 'hardBreak') {
    return '\n';
  }

  if (node.type !== 'text') {
    return renderAdfInlineContent(node.content || []);
  }

  return applyMarks(node.text || '', node.marks || []);
}

function applyMarks(text, marks) {
  return marks.reduce((formattedText, mark) => {
    switch (mark.type) {
      case 'code':
        return `\`${formattedText.replace(/`/g, '\\`')}\``;
      case 'em':
        return `_${formattedText}_`;
      case 'link':
        return `[${formattedText}](${mark.attrs?.href || ''})`;
      case 'strike':
        return `~~${formattedText}~~`;
      case 'strong':
        return `**${formattedText}**`;
      default:
        return formattedText;
    }
  }, text);
}

function extractPlainText(node) {
  if (!node) {
    return '';
  }

  if (node.type === 'text') {
    return node.text || '';
  }

  return (node.content || []).map((child) => extractPlainText(child)).join('');
}

function prefixLines(text, prefix) {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
