/** Canonical POSIX ustar, as `JobOutputStore.seal` writes it: lexical files, two zero blocks. */
export function ustar(members: readonly (readonly [string, string])[]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of members) {
    const content = Buffer.from(body, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    const octal = (value: number, offset: number, length: number) =>
      header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
    octal(0o600, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(content.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 0x30;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
