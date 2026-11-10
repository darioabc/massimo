// The app extends a local theme layer and a remote one; the folders under
// layers/ that hold a nuxt.config are layers too.
export default defineNuxtConfig({
  extends: ['./vendor/theme', 'github:acme/remote-layer'],
  modules: ['shadcn-nuxt'],
  shadcn: {
    prefix: '',
    componentDir: '@/components/ui',
  },
  alias: {
    '#data': './data',
  },
  components: ['~/components', { path: '~/widgets', prefix: 'Widget', pathPrefix: false }],
  compatibilityDate: '2025-01-01',
})
