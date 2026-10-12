export type Preferences = { gender: 'female' | 'male'; name: string; address: string; tone: 'warm' | 'professional' | 'lively'; detail: 'concise' | 'balanced' | 'detailed'; habits: string }
export const defaultPreferences: Preferences = {gender:'female',name:'李婉儿',address:'老板',tone:'warm',detail:'balanced',habits:'先说结论，再列出下一步；遇到关键缺失信息再提问。'}
export const portrait = (gender: Preferences['gender']) => `/assets/secretary/${gender === 'male' ? 'male-secretary' : 'li-waner'}.png`
