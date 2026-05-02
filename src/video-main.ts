import { mountVideoUi } from './video-ui';

const root = document.getElementById('app');
if (!root) {
  throw new Error('#app root element not found');
}
mountVideoUi(root);
