import { CssBaseline } from '@mui/material';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './i18n';
import { store } from './store';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><Provider store={store}><BrowserRouter><CssBaseline /><App /></BrowserRouter></Provider></React.StrictMode>);
