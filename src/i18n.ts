import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

i18n.use(initReactI18next).init({
  lng: 'zh',
  resources: { zh: { translation: { title: '动态表单规则编排与版本迁移模拟器', publish: '发布会话', simulate: '迁移模拟', runtime: '运行态表单' } } }
});

export default i18n;
