/**
 * zen-fs-sync — 默认冲突解决器
 *
 * 支持 source-wins / target-wins / merge 三种策略。
 * merge 仅对 JSON 文件执行深合并，其余类型回退到 source-wins。
 */

import type { ConflictResolver } from '../types';
import { ConflictStrategy } from '../types';
import { deepMergeJSON, isJsonPath, tryParseJSON } from '../utils';

export class DefaultConflictResolver implements ConflictResolver {
  async resolve(
    path: string,
    sourceContent: string,
    targetContent: string,
    strategy: ConflictStrategy,
  ): Promise<{ content: string; strategy: ConflictStrategy }> {
    switch (strategy) {
      case ConflictStrategy.SourceWins:
        return { content: sourceContent, strategy };

      case ConflictStrategy.TargetWins:
        return { content: targetContent, strategy };

      case ConflictStrategy.Merge: {
        // 非文件 JSON 路径回退
        if (!isJsonPath(path)) {
          return { content: sourceContent, strategy: ConflictStrategy.SourceWins };
        }

        const sourceJSON = tryParseJSON(sourceContent);
        const targetJSON = tryParseJSON(targetContent);

        // 解析失败回退
        if (sourceJSON === undefined || targetJSON === undefined) {
          return { content: sourceContent, strategy: ConflictStrategy.SourceWins };
        }

        const merged = deepMergeJSON(targetJSON, sourceJSON);
        return {
          content: JSON.stringify(merged, null, 2),
          strategy,
        };
      }

      default:
        return { content: sourceContent, strategy: ConflictStrategy.SourceWins };
    }
  }
}