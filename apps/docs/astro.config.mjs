import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

const site = process.env.DOCS_SITE ?? 'https://misaon.github.io'
const base = process.env.DOCS_BASE ?? '/byte-bureau'

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: 'ByteBureau',
      description: 'The AI office: a bureau of coding agents in isolated workspaces.',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        cs: { label: 'Čeština', lang: 'cs' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/misaon/byte-bureau' }],
      editLink: { baseUrl: 'https://github.com/misaon/byte-bureau/edit/main/apps/docs/' },
      sidebar: [
        {
          label: 'Start',
          translations: { cs: 'Začínáme' },
          items: [
            { label: 'Introduction', translations: { cs: 'Úvod' }, link: '/' },
            'install',
            'architecture',
            {
              label: 'Daemon and API',
              translations: { cs: 'Démon a API' },
              link: '/daemon-and-api/',
            },
            {
              label: 'Agents and profiles',
              translations: { cs: 'Agenti a profily' },
              link: '/agents-and-profiles/',
            },
            'contributing',
          ],
        },
        {
          label: 'Decisions',
          translations: { cs: 'Rozhodnutí' },
          items: [{ autogenerate: { directory: 'decisions' } }],
        },
      ],
    }),
  ],
})
