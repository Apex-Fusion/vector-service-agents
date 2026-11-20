// packages/usecase-kit/src/decision/lossless.ts
// A JSON text that says one thing. `JSON.parse` keeps the LAST of two members that have the same key, and it rounds a number to the nearest double. In both cases the value that a decision records is
// not the value that the model wrote, or the model wrote two values and the text does not say which one it meant. So the reading of an answer refuses a text that has:
//   - a key that stands two times in one object, at any depth. The keys are compared as the texts that they stand for, so `"a"` and `"\u0061"` are the same key;
//   - a number that does not read back as itself. The double that `JSON.parse` makes of a number is written with the shortest text that reads back as that double. This text must be the same decimal
//     number as the number that the model wrote. A number of up to 15 significant digits passes, so do the safe integers, and so does a number that a double prints in full (`0.30000000000000004`).
//     `9007199254740993`, `12345678901234567890`, `0.10000000000000001` and `1e-400` do not pass.
// The text must be valid JSON. `JSON.parse` has read it before this check runs.

/** A number in JSON, read from a place in the text. */
const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * The significant digits of a number in its text: no sign, no point, no exponent, no leading zeros and no trailing zeros. A zero has no digits. A text that is not a number of JSON has none.
 * The double of a number is the nearest to it, and its shortest text is within half a step of the double. So two texts of one double that have the same digits have the same point too.
 */
function digitsOf(text: string): string | null {
  const match = /^-?(\d+)(?:\.(\d+))?(?:[eE][+-]?\d+)?$/.exec(text);
  return match === null ? null : `${match[1]}${match[2] ?? ''}`.replace(/^0+/, '').replace(/0+$/, '');
}

/** True when the number reads back as itself: the shortest text of its double has the digits of the number. `Infinity` has no digits, so a number that overflows does not pass. */
function readsBack(literal: string): boolean {
  const written = digitsOf(literal);
  return written !== null && written === digitsOf(String(Number(literal)));
}

/**
 * What reading a JSON text would lose, as a short phrase for a detail, or null when it would lose nothing. The phrase never repeats a key or a number of the text. A frame of the walk is the Set
 * of the keys of an object, or null for an array.
 */
export function losses(json: string): string | null {
  const frames: Array<Set<string> | null> = [];
  let expectKey = false;
  let at = 0;
  while (at < json.length) {
    const char = json[at]!;
    if (char === '"') {
      let end = at + 1;
      while (json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
      const frame = frames[frames.length - 1];
      if (expectKey && frame instanceof Set) {
        const key = JSON.parse(json.slice(at, end + 1)) as string;
        if (frame.has(key)) return 'has a key that stands two times in one object';
        frame.add(key);
      }
      expectKey = false;
      at = end + 1;
    } else if (char === '-' || (char >= '0' && char <= '9')) {
      NUMBER.lastIndex = at;
      const literal = NUMBER.exec(json)![0];
      if (!readsBack(literal)) return 'has a number that a double does not hold without loss';
      at += literal.length;
    } else {
      if (char === '{') {
        frames.push(new Set());
        expectKey = true;
      } else if (char === '[') {
        frames.push(null);
      } else if (char === '}' || char === ']') {
        frames.pop();
      } else if (char === ',') {
        expectKey = true;
      }
      at += 1;
    }
  }
  return null;
}
