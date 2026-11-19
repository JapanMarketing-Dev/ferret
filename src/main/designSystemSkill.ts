import { homedir } from 'node:os'
import { DESIGN_SYSTEM_SKILL_NAME, isDesignSystemSkill, renderDesignSystemSkill } from '@shared/designSystemSkill'
import { syncMarkedSkill } from './visualReviewSkill'

/** skill「ferret-design-system」を、使っている Agent に入れて今の版に合わせる（ferret-visual-review と同じ決まり）。書いたファイルの数を返す */
export async function syncDesignSystemSkill(version: string, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return syncMarkedSkill(DESIGN_SYSTEM_SKILL_NAME, renderDesignSystemSkill(version), isDesignSystemSkill, home, env)
}
