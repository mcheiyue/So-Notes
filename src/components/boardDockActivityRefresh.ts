export const shouldCommitActivityRefresh = (
  requestId: number,
  latestRequestId: number,
): boolean => requestId === latestRequestId;
