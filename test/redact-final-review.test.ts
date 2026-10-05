import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redact } from '../src/core/redact.js';

const material = 'MIIE' + 'A'.repeat(32);

const privateKeys = [
  ['space-flattened', `-----BEGIN RSA PRIVATE KEY----- ${material} -----END RSA PRIVATE KEY-----`],
  [
    'escaped CRLF',
    `-----BEGIN RSA PRIVATE KEY-----\\r\\n${material}\\r\\n-----END RSA PRIVATE KEY-----`,
  ],
  [
    'trailing spaces',
    `-----BEGIN RSA PRIVATE KEY----- \t \n${material}\n-----END RSA PRIVATE KEY-----`,
  ],
  ['no separator', `-----BEGIN RSA PRIVATE KEY-----${material}-----END RSA PRIVATE KEY-----`],
  [
    'double space in header',
    `-----BEGIN  RSA PRIVATE KEY-----\n${material}\n-----END RSA PRIVATE KEY-----`,
  ],
  ['tab in header', `-----BEGIN\tRSA PRIVATE KEY-----\n${material}\n-----END RSA PRIVATE KEY-----`],
  [
    'variable header word spacing',
    `-----BEGIN RSA\tPRIVATE  KEY----- ${material} -----END RSA PRIVATE KEY-----`,
  ],
];

const pascalNameAssignments = [
  ['{"ClientSecret":"hunter2"}', '{[REDACTED]}'],
  ['{"SecretKey":"hunter2"}', '{[REDACTED]}'],
  ['$ClientSecret = "hunter2"', '$[REDACTED]'],
  ['ClientSecret: "hunter2",', '[REDACTED],'],
  ['ClientSecret = "hunter2";', '[REDACTED];'],
  ['PrivateKey = "x9f..."', '[REDACTED]'],
  ['SigningKey: abc123', '[REDACTED]'],
  ['AppSecret=abc123', '[REDACTED]'],
  ['$env:ClientSecret = "x"', '$env:[REDACTED]'],
];

const unanchoredNameAssignments = [
  ['mytoken=abcdefghijklmnopqrstuvwx', '[REDACTED]'],
  ['sessiontoken=abcdefghijklmnopqrstuvwx', '[REDACTED]'],
  ['csrftoken=abcdefghijklmnopqrstuvwx', '[REDACTED]'],
  [
    'Cookie: csrftoken=abcdefghijklmnopqrstuvwx; sessionid=keep',
    'Cookie: [REDACTED]; sessionid=keep',
  ],
  ['xsrftoken=abcdefghijklmnopqrstuvwx', '[REDACTED]'],
  ['bottoken=abcdefghijklmnopqrstuvwx', '[REDACTED]'],
  ['?apitoken=abcdefghijklmnopqrstuvwx&page=2', '?[REDACTED]&page=2'],
  ['myapikey=abcdefghijklmnopqrstuvwx', '[REDACTED]'],
];

const footerConfirmedKeys = [
  [
    'double-escaped newlines',
    String.raw`-----BEGIN RSA PRIVATE KEY-----\\nMIIE\\n-----END RSA PRIVATE KEY-----`,
  ],
  ['CR-only separators', '-----BEGIN RSA PRIVATE KEY-----\rMIIE\r-----END RSA PRIVATE KEY-----'],
  [
    'backslash-newline separators',
    '-----BEGIN RSA PRIVATE KEY-----\\\nMIIE\\\n-----END RSA PRIVATE KEY-----',
  ],
  ['HTML separators', '-----BEGIN RSA PRIVATE KEY-----<br>MIIE<br>-----END RSA PRIVATE KEY-----'],
  ['short first line', '-----BEGIN RSA PRIVATE KEY-----MIIE\n...-----END RSA PRIVATE KEY-----'],
];

const pascalAssignments = [
  ['password=Hunter', '[REDACTED]'],
  ['password: Winter', '[REDACTED]'],
  ['db_password: Summer', '[REDACTED]'],
  ['secret: Secret', '[REDACTED]'],
  ['token=Abcdefghijklmnopqrstuvwxyz', '[REDACTED]'],
  ['password: SecretStr', '[REDACTED]'],
  ['token: Jwt', '[REDACTED]'],
  ['const password = SecretStr;', 'const [REDACTED];'],
  ['secret: True', '[REDACTED]'],
  ['secret: String', '[REDACTED]'],
  ['secret: Integer', '[REDACTED]'],
  ['secret: Optional', '[REDACTED]'],
  ['secret: Any', '[REDACTED]'],
  ['token: TokenType;', '[REDACTED];'],
  ['const token = response.data.token;', 'const [REDACTED];'],
  ['const api_key = process.env.API_KEY;', 'const [REDACTED];'],
  ['const api_key = import.meta.env.API_KEY;', 'const [REDACTED];'],
];

const ordinaryAssignments = [
  'monkey=banana',
  'turkey: ankara',
  'hockey: 7pm',
  'whiskey=lagavulin',
  'hotkey=ctrl+k',
  '{"monkey":"see"}',
  'Turkey: notes',
  'notes: monkey=banana',
  'const hotkey = "ctrl+k";',
  'Monkey=1',
  'Keyboard=us',
  'MyKeyboard=us',
  'monkey=',
  'turkey:',
  'broken=yes',
  'token_count = 5',
  'tokenizer: bert',
  'secretary: alice',
  'secret: 42',
  'max_tokens: 4096',
  'Use AccountKey=abc in docs',
  'Use SharedAccessKey=abc in docs',
  'Use AccountKey=fffffffffffffff in docs',
  'Use SharedAccessKey=fffffffffffffff in docs',
];

const envQuotes = [
  [String.raw`PGPASSWORD=\"hunter2\" psql`, '[REDACTED] psql'],
  [String.raw`run MYSQL_PWD=\"hun ter2\" mysql`, 'run [REDACTED] mysql'],
  ["PGPASSWORD=$'hunter2' psql", '[REDACTED] psql'],
  [String.raw`run PGPASSWORD=$'hun\'ter2' psql`, 'run [REDACTED] psql'],
  [String.raw`PGPASSWORD=\"hunter2 psql`, '[REDACTED] psql'],
];

const templates = [
  ['apiKey = `hunter2`', '[REDACTED]'],
  ['clientSecret: `hunter2`', '[REDACTED]'],
  ['const password = `hun ter2`;', 'const [REDACTED];'],
  ['apiKey = `line1\nline2`', '[REDACTED]'],
  ['apiKey = `hun\\`ter2`', '[REDACTED]'],
];

const urlPasswords = [
  ['https://user:p@ss@host', '[REDACTED]host'],
  ['https://user:p@ss@word@host/path', '[REDACTED]host/path'],
  ['redis://:p@ss@host:6379', '[REDACTED]host:6379'],
  ['https://user:p@ss/word@host', '[REDACTED]host'],
  ['https://user:p@ss@host https://host/path', '[REDACTED]host https://host/path'],
  ['{"url":"https://u:p@h","email":"a@b.c"}', '{"url":"[REDACTED]h","email":"a@b.c"}'],
  ["'https://u:p@h','a@b.c'", "'[REDACTED]h','a@b.c'"],
  ['https://u:p@h,a@b.c', '[REDACTED]h,a@b.c'],
];

const delimiterPasswords = [
  ['https://user:pa,ss@host/path', '[REDACTED]host/path'],
  ["https://user:pa'ss@host/path", '[REDACTED]host/path'],
  ['postgres://u:p,w@db.example.com:5432/app', '[REDACTED]db.example.com:5432/app'],
  ['mongodb+srv://u:a,b,c@cluster0.mongodb.net', '[REDACTED]cluster0.mongodb.net'],
  ['redis://:p,w@host:6379', '[REDACTED]host:6379'],
  ['amqp://guest:gu,est@rabbit:5672', '[REDACTED]rabbit:5672'],
];

const unseparatedKeyNames = [
  'secretkey',
  'privatekey',
  'accesskey',
  'signingkey',
  'sshkey',
  'myapikey',
];

describe('final secret-filter review regressions', () => {
  it.each(pascalNameAssignments)('redacts PascalCase secret names: %s', (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it.each(unanchoredNameAssignments)(
    'redacts unseparated secret suffixes: %s',
    (text, expected) => {
      expect(redact(text)).toBe(expected);
    }
  );

  it.each(footerConfirmedKeys)('redacts footer-confirmed PEM with %s', (_name, key) => {
    expect(redact(`before ${key} after`)).toBe('before [REDACTED] after');
  });

  it('bounds the footer-confirmation window to 8192 characters', () => {
    const header = '-----BEGIN RSA PRIVATE KEY-----';
    const footer = '-----END RSA PRIVATE KEY-----';
    expect(redact(header + '!'.repeat(8192) + footer)).toBe('[REDACTED]');
    const beyondWindow = header + '!'.repeat(8193) + footer;
    expect(redact(beyondWindow)).toBe(beyondWindow);
  });

  it('preserves a prose-only PEM header without a footer', () => {
    const prose = 'I pasted my -----BEGIN RSA PRIVATE KEY----- into the form';
    expect(redact(prose)).toBe(prose);
  });

  it('bounds a 250 KiB flood of footer-less PEM header mentions', () => {
    const mention = '-----BEGIN RSA PRIVATE KEY----- into the form ';
    const size = 250 * 1024;
    const text = mention.repeat(Math.ceil(size / mention.length)).slice(0, size);
    expect(Buffer.byteLength(text, 'utf8')).toBe(size);
    const start = performance.now();
    const result = redact(text);
    expect(performance.now() - start).toBeLessThan(200);
    expect(result).toBe(text);
  });

  it.each(['token=12345678901234567890', 'api_key=123456789012345678901234'])(
    'redacts numeric secret values of 20 or more digits: %s',
    (text) => {
      expect(redact(text)).toBe('[REDACTED]');
    }
  );

  it.each(privateKeys)('redacts PEM with %s', (_name, key) => {
    expect(redact(`before ${key} after`)).toBe('before [REDACTED] after');
  });

  it('redacts flattened PEM even when its footer was truncated', () => {
    expect(redact(`before -----BEGIN RSA PRIVATE KEY----- ${material}`)).toBe('before [REDACTED]');
  });

  it.each(pascalAssignments)(
    'redacts bare values without keyword or self exemptions: %s',
    (text, expected) => {
      expect(redact(text)).toBe(expected);
    }
  );

  it.each(ordinaryAssignments)('preserves ordinary words ending in secret suffixes: %s', (text) => {
    expect(redact(text)).toBe(text);
  });

  it.each(['apiKey', 'secretAccessKey', 'clientSecret', 'refreshToken', 'dbPassword', 'dbPasswd'])(
    'still redacts case-sensitive camelCase assignments: %s',
    (name) => {
      expect(redact(`${name}=Hunter command`)).toBe('[REDACTED] command');
      expect(redact(`before {${name}: Hunter, next: ok}`)).toBe('before {[REDACTED], next: ok}');
      expect(redact(`{"${name}":"hunter2"}`)).toBe('{[REDACTED]}');
    }
  );

  it.each(envQuotes)('redacts entire inline shell-quoted env value: %s', (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it.each(templates)('redacts entire template-literal value: %s', (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it.each(['PASSPHRASE', 'SSH_PASSPHRASE', 'APP_PIN'])(
    'redacts inline passphrase or whole-word PIN suffix: %s',
    (name) => {
      expect(redact(`run ${name}=hunter2 command`)).toBe('run [REDACTED] command');
    }
  );

  it.each(['SPIN', 'TOPPIN'])('does not treat embedded PIN letters as a suffix: %s', (name) => {
    expect(redact(`run ${name}=setting command`)).toBe(`run ${name}=setting command`);
  });

  it.each(urlPasswords)('redacts URL passwords containing @: %s', (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it.each(delimiterPasswords)(
    'redacts URL passwords containing commas or apostrophes: %s',
    (text, expected) => {
      expect(redact(text)).toBe(expected);
    }
  );

  it.each(unseparatedKeyNames)('redacts unseparated secret key names: %s', (name) => {
    expect(redact(`${name}=abcdefghijklmnopqrstuvwx`)).toBe('[REDACTED]');
  });

  it.each(['monkey=1', 'turkey: x', 'keyboard=us', 'hotkey=ctrl'])(
    'keeps ordinary words ending in key: %s',
    (text) => {
      expect(redact(text)).toBe(text);
    }
  );

  it.each([
    ['password=hun|ter2 command', '[REDACTED] command'],
    ['password: hun|ter2 command', 'password: hun|ter2 command'],
    ['password=hunter2) next', '[REDACTED]) next'],
    ['password=${PASSWORD}', '[REDACTED]'],
    ['apiKey=${PASSWORD}', '[REDACTED]'],
  ])('pins documented value delimiters and placeholders: %s', (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it('documents equals-only wide values, closing parentheses and redacted placeholders', () => {
    const privacy = readFileSync('docs/PRIVACY.md', 'utf8');
    expect(privacy).toContain('not bare `key: value` colon forms');
    expect(privacy).toContain('`)` terminates unquoted values');
    expect(privacy).toContain('placeholders like `${PASSWORD}` are redacted');
    expect(privacy).not.toContain('PascalCase type name');
    expect(privacy).toContain('`//` ends userinfo scanning');
  });
});
