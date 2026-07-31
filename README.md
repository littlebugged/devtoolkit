# DevToolKit

Free online developer tools — all running client-side in the browser.

## Tools Included

- JSON Formatter & Validator
- Base64 Encoder & Decoder
- URL Encoder & Decoder
- UUID Generator
- Hash Generator (SHA-1, SHA-256, SHA-512)
- Password Generator
- Color Picker & Converter
- Unix Timestamp Converter
- Lorem Ipsum Generator
- Word & Character Counter
- Text Case Converter
- Markdown Preview

## Development

```bash
npm install
npm run dev      # Start dev server at http://localhost:4321
npm run build    # Build for production
npm run preview  # Preview production build
```

## Deploy to Cloudflare Pages

1. Push this repo to GitHub
2. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → Pages → Create a project
3. Connect your GitHub repository
4. Build settings:
   - **Framework preset**: Astro
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
5. Deploy

## Ad Integration (Adsterra)

1. Sign up at [Adsterra Publishers](https://publishers.adsterra.com/)
2. Create ad units (Banner 728x90, Native Banner 300x250)
3. Replace the ad placeholder code in `src/layouts/BaseLayout.astro` and `src/layouts/ToolLayout.astro`

## Configuration

- Update `site` in `astro.config.mjs` with your domain
- Update `robots.txt` sitemap URL
- Update `about.astro` contact email
