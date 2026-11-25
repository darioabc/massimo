// The web platform adapter. Web is every massimo subsystem as it was before
// platforms: detect.mjs's framework and styling detection, the graph, the
// audit, the story lanes and the CSS-family token outputs, all reading the
// config's top-level keys. This adapter only names them, so the registry can
// list web beside iOS and Android; it changes none of them.

import { isStoryFile, isTestFile } from './source.mjs'

export const WEB_FORMATS = ['css', 'tailwind4', 'tailwind3', 'scss', 'json', 'ts', 'designmd']

export const web = {
  id: 'web',
  // detect.mjs's detectFramework stays the web detector; the suggested config's top-level keys are web's block.
  detect: null,
  defaults: () => ({}),
  isTest: isTestFile,
  isStory: isStoryFile,
  tokens: { formats: WEB_FORMATS },
}
