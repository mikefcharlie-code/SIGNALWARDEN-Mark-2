export type WorkbenchGroup = 'llm' | 'image-generation' | 'video-generation' | 'image-classification' | 'video-classification'
export type WorkbenchDevice = 'cpu' | 'cuda'
export type SetupAction = 'plan' | 'setup' | 'download' | 'verify'

export function commandFor(root: string, group: WorkbenchGroup, device: WorkbenchDevice, action: SetupAction) {
  if (action === 'plan' || action === 'verify') return `python3 ${root}/scripts/local_ai_setup.py ${action} --group ${group}`
  if (action === 'download') return `python3 ${root}/scripts/local_ai_setup.py download --group ${group} --accept-license --yes`
  return `python3 ${root}/scripts/local_ai_setup.py setup --group ${group} --device ${device} --yes`
}

export function registryStatusCommand(root: string) {
  return `python3 ${root}/scripts/local_ai_setup.py doctor`
}

export function smokeCommand(root: string, group: WorkbenchGroup, device: WorkbenchDevice) {
  const output = group === 'image-generation' ? 'image-smoke.png' : group === 'video-generation' ? 'video-smoke.gif' : group === 'image-classification' ? 'image-classification-fixture.png' : group === 'video-classification' ? 'video-classification-fixture.gif' : null
  const outputFlag = output ? ` --output "$UCAS_AI_HOME/outputs/${output}"` : ''
  return `export UCAS_AI_HOME="$HOME/.cache/ucas-ai"\n"$UCAS_AI_HOME/venvs/${group}/bin/python" ${root}/scripts/local_ai_run.py \\\n  smoke --group ${group} --device ${device}${outputFlag}`
}

export function deviceForGroup(group: WorkbenchGroup, requested: WorkbenchDevice): WorkbenchDevice {
  return group === 'video-generation' ? 'cuda' : requested
}

export function externalConfiguration(_model: string) {
  return `export UCAS_AI_EXTERNAL_MODEL="\${UCAS_CHOSEN_EXTERNAL_MODEL:?Set a provider-supported model in trusted shell}"\nexport UCAS_AI_MODE=external UCAS_AI_EXTERNAL_PROVIDER=openai UCAS_AI_EXTERNAL_CONSENT=true\n# Set UCAS_AI_EXTERNAL_API_KEY in the trusted server shell only; never in browser credentials.`
}
