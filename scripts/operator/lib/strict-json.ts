/** Find the first duplicate object member after decoding escapes. The caller must parse the JSON first. */
export function repeatedMember(json: string): string | null {
  const open: (Set<string> | null)[] = [];
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '{') open.push(new Set());
    else if (char === '[') open.push(null);
    else if (char === '}' || char === ']') open.pop();
    else if (char === '"') {
      let end = i + 1;
      while (end < json.length && json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
      let next = end + 1;
      while (next < json.length && ' \t\n\r'.includes(json[next]!)) next++;
      const members = open[open.length - 1];
      if (members !== undefined && members !== null && json[next] === ':') {
        const name = JSON.parse(json.slice(i, end + 1)) as string;
        if (members.has(name)) return name;
        members.add(name);
      }
      i = end;
    }
  }
  return null;
}
