export interface Tool {
  slug: string;
  name: string;
  description: string;
  metaDescription: string;
  category: string;
  icon: string;
  keywords: string[];
}

export const categories = [
  { id: 'text', name: 'Text & Data', icon: '📝' },
  { id: 'encoding', name: 'Encoding & Decoding', icon: '🔄' },
  { id: 'generators', name: 'Generators', icon: '⚡' },
  { id: 'security', name: 'Security & Crypto', icon: '🔒' },
  { id: 'converters', name: 'Converters', icon: '🔀' },
  { id: 'web', name: 'Web & Dev', icon: '🌐' },
] as const;

export const tools: Tool[] = [
  {
    slug: 'json-formatter',
    name: 'JSON Formatter & Validator',
    description: 'Format, validate, and beautify your JSON data with syntax highlighting.',
    metaDescription: 'Free online JSON formatter and validator. Beautify, minify, and validate JSON data instantly. No signup required.',
    category: 'text',
    icon: '{ }',
    keywords: ['json formatter', 'json validator', 'json beautifier', 'json prettify', 'format json online'],
  },
  {
    slug: 'base64-encoder-decoder',
    name: 'Base64 Encoder & Decoder',
    description: 'Encode text to Base64 or decode Base64 strings back to plain text.',
    metaDescription: 'Free online Base64 encoder and decoder. Convert text to Base64 and Base64 to text instantly. Supports UTF-8.',
    category: 'encoding',
    icon: 'B64',
    keywords: ['base64 encode', 'base64 decode', 'base64 converter', 'base64 online'],
  },
  {
    slug: 'url-encoder-decoder',
    name: 'URL Encoder & Decoder',
    description: 'Encode or decode URLs and query parameters for safe transmission.',
    metaDescription: 'Free online URL encoder and decoder. Percent-encode special characters or decode URL-encoded strings instantly.',
    category: 'encoding',
    icon: '%20',
    keywords: ['url encode', 'url decode', 'percent encoding', 'urlencode online'],
  },
  {
    slug: 'uuid-generator',
    name: 'UUID Generator',
    description: 'Generate random UUIDs (v4) in bulk. Copy with one click.',
    metaDescription: 'Free online UUID/GUID generator. Generate random UUID v4 identifiers in bulk. Copy to clipboard instantly.',
    category: 'generators',
    icon: '#',
    keywords: ['uuid generator', 'guid generator', 'random uuid', 'uuid v4', 'unique id generator'],
  },
  {
    slug: 'hash-generator',
    name: 'Hash Generator (MD5, SHA)',
    description: 'Generate MD5, SHA-1, SHA-256, and SHA-512 hashes from any text.',
    metaDescription: 'Free online hash generator. Create MD5, SHA-1, SHA-256, SHA-512 hashes from text. Secure client-side hashing.',
    category: 'security',
    icon: '#!',
    keywords: ['md5 hash', 'sha256 hash', 'hash generator', 'sha1 online', 'checksum generator'],
  },
  {
    slug: 'password-generator',
    name: 'Password Generator',
    description: 'Create strong, random passwords with customizable length and character types.',
    metaDescription: 'Free online strong password generator. Create secure random passwords with custom length, symbols, and numbers.',
    category: 'security',
    icon: '🔑',
    keywords: ['password generator', 'random password', 'strong password', 'secure password generator'],
  },
  {
    slug: 'color-picker',
    name: 'Color Picker & Converter',
    description: 'Pick colors and convert between HEX, RGB, and HSL formats.',
    metaDescription: 'Free online color picker and converter. Convert between HEX, RGB, and HSL color formats. Visual color palette tool.',
    category: 'web',
    icon: '🎨',
    keywords: ['color picker', 'hex to rgb', 'rgb to hex', 'color converter', 'hsl converter'],
  },
  {
    slug: 'timestamp-converter',
    name: 'Unix Timestamp Converter',
    description: 'Convert Unix timestamps to human-readable dates and vice versa.',
    metaDescription: 'Free online Unix timestamp converter. Convert epoch timestamps to dates and dates to timestamps. Supports multiple formats.',
    category: 'converters',
    icon: '⏱',
    keywords: ['unix timestamp', 'epoch converter', 'timestamp to date', 'date to timestamp'],
  },
  {
    slug: 'lorem-ipsum-generator',
    name: 'Lorem Ipsum Generator',
    description: 'Generate placeholder text in paragraphs, sentences, or words.',
    metaDescription: 'Free online Lorem Ipsum generator. Create dummy placeholder text for design mockups. Generate paragraphs, sentences, or words.',
    category: 'generators',
    icon: 'Aa',
    keywords: ['lorem ipsum', 'placeholder text', 'dummy text generator', 'lipsum'],
  },
  {
    slug: 'word-counter',
    name: 'Word & Character Counter',
    description: 'Count words, characters, sentences, and paragraphs in your text.',
    metaDescription: 'Free online word counter and character counter. Count words, characters, sentences, paragraphs, and reading time.',
    category: 'text',
    icon: '123',
    keywords: ['word counter', 'character counter', 'letter count', 'word count online'],
  },
  {
    slug: 'case-converter',
    name: 'Text Case Converter',
    description: 'Convert text between UPPERCASE, lowercase, Title Case, camelCase, and more.',
    metaDescription: 'Free online text case converter. Transform text to uppercase, lowercase, title case, camelCase, snake_case instantly.',
    category: 'text',
    icon: 'Aa',
    keywords: ['uppercase converter', 'lowercase converter', 'title case', 'camelCase converter'],
  },
  {
    slug: 'markdown-preview',
    name: 'Markdown Preview',
    description: 'Write Markdown and see the rendered HTML preview in real time.',
    metaDescription: 'Free online Markdown editor and previewer. Write Markdown and see live HTML preview side by side.',
    category: 'web',
    icon: 'MD',
    keywords: ['markdown editor', 'markdown preview', 'markdown to html', 'markdown viewer online'],
  },
];

export function getToolsByCategory(categoryId: string): Tool[] {
  return tools.filter(t => t.category === categoryId);
}

export function getToolBySlug(slug: string): Tool | undefined {
  return tools.find(t => t.slug === slug);
}
