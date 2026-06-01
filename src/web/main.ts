import { mount } from 'svelte';
import App from './App.svelte';
import './styles.css';

const target = document.getElementById('app');

if (!target) {
  throw new Error('Keryx mount target #app was not found.');
}

export const app = mount(App, { target });
