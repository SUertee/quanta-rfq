import {appUrl} from './engine/appUrl';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './workspace-controls.css';

if (!new URLSearchParams(location.search).has('workspace')) {
  location.replace(appUrl('quanta.html'));
} else ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
