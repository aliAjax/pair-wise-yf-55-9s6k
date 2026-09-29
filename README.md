# pair-wise-yf-55 动态表单规则编排和版本迁移模拟器

## 源提示词摘要
业务人员拖拽字段、设置分组、联动条件、计算规则、必填逻辑和多语言文案；发布前模拟旧数据在新结构下的迁移。系统比较版本差异，警告失效规则、循环依赖和引用删除，同时按历史版本解释过去提交的数据。

## 技术栈
React 19 + TypeScript + Vite + MUI + Redux Toolkit + RTK Query + React Router + React Hook Form + Zod + i18next + dnd-kit。

## 已实现闭环
- 表单版本、字段、联动规则和旧数据快照等业务对象。
- 字段拖拽排序、新增字段、添加联动规则、发布新版本。
- 新旧版本差异、旧数据迁移缺口模拟。
- 运行态动态表单、跨字段校验和历史版本解释。
- localStorage 持久化。

## 启动
```bash
npm install
npm run dev
```
开发端口：62020
