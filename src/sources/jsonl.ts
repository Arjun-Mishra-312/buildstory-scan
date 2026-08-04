import { createReadStream } from "node:fs";

const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Streams a file as newline-delimited records without ever holding the whole
 * file in memory. `onLine` returns `false` to stop early (used once a
 * session's repository scope has been resolved as out-of-scope). Oversized
 * lines are discarded rather than truncated, so a parser never sees a partial
 * JSON value.
 */
export async function consumeJsonLines(
  filePath: string,
  onLine: (line: Buffer, ordinal: number) => boolean,
): Promise<{ oversizedLines: number }> {
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  let carry = Buffer.alloc(0);
  let discarding = false;
  let oversizedLines = 0;
  let ordinal = 0;
  let stopped = false;

  for await (const rawChunk of stream) {
    if (stopped) break;
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) {
        if (!discarding) {
          const remainder = chunk.subarray(offset);
          if (carry.length + remainder.length > MAX_JSONL_LINE_BYTES) {
            carry = Buffer.alloc(0);
            discarding = true;
            oversizedLines += 1;
          } else {
            carry = carry.length === 0 ? Buffer.from(remainder) : Buffer.concat([carry, remainder]);
          }
        }
        break;
      }

      const segment = chunk.subarray(offset, newline);
      offset = newline + 1;
      ordinal += 1;
      if (discarding) {
        discarding = false;
        continue;
      }
      if (carry.length + segment.length > MAX_JSONL_LINE_BYTES) {
        carry = Buffer.alloc(0);
        oversizedLines += 1;
        continue;
      }
      let line = carry.length === 0 ? Buffer.from(segment) : Buffer.concat([carry, segment]);
      carry = Buffer.alloc(0);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length > 0 && !onLine(line, ordinal)) {
        stopped = true;
        break;
      }
    }
  }

  if (!stopped && !discarding && carry.length > 0) {
    ordinal += 1;
    onLine(carry, ordinal);
  }
  return { oversizedLines };
}
