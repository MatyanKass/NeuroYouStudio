import { randomBytes } from 'node:crypto'

export const newId = (prefix = ''): string => `${prefix}${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
