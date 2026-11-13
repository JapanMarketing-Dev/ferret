import { homedir } from 'node:os'
import { VALUE_USECASE_SKILL_NAME, isValueUseCaseSkill, renderValueUseCaseSkill } from '@shared/valueUseCaseSkill'
import { syncMarkedSkill } from './visualReviewSkill'

/** skill「ferret-value-usecases」を、使っている Agent に入れて今の版に合わせる（ferret-visual-review と同じ決まり）。書いたファイルの数を返す */
export async function syncValueUseCaseSkill(version: string, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return syncMarkedSkill(VALUE_USECASE_SKILL_NAME, renderValueUseCaseSkill(version), isValueUseCaseSkill, home, env)
}
