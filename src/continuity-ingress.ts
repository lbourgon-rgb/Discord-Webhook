export async function commitRequiredContinuityIngress(options: {
  postContinuity: () => Promise<unknown>;
  storeCommand: () => boolean;
  logLocal: () => void;
}): Promise<boolean> {
  await options.postContinuity();
  if (!options.storeCommand()) return false;
  options.logLocal();
  return true;
}
