import { defineConfig } from 'vitepress';

const repo = 'https://github.com/elderfo/mehmory';
const docs = `${repo}/blob/main/docs`;

export default defineConfig({
  title: 'mehmory',
  description:
    'Hook-enforced, model-maintained markdown wiki memory for Claude Code. Markdown and git. No embeddings, no MCP server, no cloud.',
  // Project page under github.io/mehmory/. Drop this if a custom domain ever fronts it.
  base: '/mehmory/',
  cleanUrls: true,
  lastUpdated: true,
  head: [['meta', { name: 'theme-color', content: '#3c8772' }]],
  themeConfig: {
    nav: [
      { text: 'Why', link: '/why' },
      { text: 'Quickstart', link: '/quickstart' },
      { text: 'How it works', link: '/how-it-works' },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: `${docs}/CLI.md` },
          { text: 'Config', link: `${docs}/CONFIG.md` },
          { text: 'Privacy', link: `${docs}/PRIVACY.md` },
          { text: 'Troubleshooting', link: `${docs}/TROUBLESHOOTING.md` },
          { text: 'Upgrading', link: `${docs}/UPGRADE.md` },
          { text: 'Architectural decisions', link: `${docs}/WORLD_MODEL.md` }
        ]
      }
    ],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Why mehmory', link: '/why' },
          { text: 'Quickstart', link: '/quickstart' }
        ]
      },
      {
        text: 'Under the hood',
        items: [{ text: 'How it works', link: '/how-it-works' }]
      }
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: {
      pattern: `${repo}/edit/main/site/:path`,
      text: 'Edit this page on GitHub'
    },
    search: { provider: 'local' },
    footer: {
      message: 'MIT licensed.',
      copyright: 'Copyright © Christopher Freddy Getsfred'
    }
  }
});
