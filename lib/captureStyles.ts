/** Factor identical declarations with identical owners into one CSS rule.
 * Every element keeps exactly its original declarations; no defaults are guessed.
 * Input must be computed longhands, so rearranging declarations is safe.
 */
export function packCaptureStyles(styles: [string, string][][]): { css: string; tokens: string[] } {
  const owners = new Map<string, number[]>();
  styles.forEach((declarations, index) => {
    for (const [property, value] of declarations) {
      const declaration = `${property}:${value};`;
      const indices = owners.get(declaration);
      if (indices) indices.push(index); else owners.set(declaration, [index]);
    }
  });
  const groups = new Map<string, { indices: number[]; declarations: string[] }>();
  for (const [declaration, indices] of owners) {
    const key = indices.join(',');
    const group = groups.get(key);
    if (group) group.declarations.push(declaration); else groups.set(key, { indices, declarations: [declaration] });
  }
  const tokens: string[][] = styles.map(() => []);
  const rules: string[] = [];
  let id = 0;
  for (const { indices, declarations } of groups.values()) {
    const token = `c${id++}`;
    indices.forEach(index => tokens[index].push(token));
    // Higher specificity than ordinary utility classes from the preview's Tailwind.
    const selector = `[data-proto-style~="${token}"]`;
    rules.push(`${selector}${selector}{${declarations.join('')}}`);
  }
  return { css: rules.join('\n'), tokens: tokens.map(values => values.join(' ')) };
}
