import Button from '../Button/Button.vue'
import Dialog from './Dialog.vue'

export default { title: 'Overlays / Dialog', component: Dialog }

export const Open = { render: () => ({ components: { Dialog, Button }, template: '<Dialog>Delete this invoice?</Dialog>' }) }
