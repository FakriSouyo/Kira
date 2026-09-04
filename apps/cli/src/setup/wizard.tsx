import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { StepIndicator } from './components/StepIndicator';
import { SecretInput } from './components/SecretInput';
import { ProviderSelector } from './components/ProviderSelector';
import { ModelSelector } from './components/ModelSelector';
import { ConnectionTest } from './components/ConnectionTest';
import { getProvider, SECTORS_KEY_HINT, type ProviderId } from './providers';
import { saveSectorsKey, saveProvider, testConnections, validateSectorsKey } from './service';
import type { ConnectionResult } from './service';

type Step = 'welcome' | 'sectors' | 'provider' | 'apikey' | 'agentModel' | 'routerModel' | 'testing' | 'done';

export function SetupWizard({
  homeDir,
  deps,
  onDone,
}: {
  homeDir: string;
  deps: {
    sectors: { getCompanyReport: (t: string) => Promise<unknown> };
    agentLlm: { generateText: (p: { prompt: string }) => Promise<unknown> };
    routerLlm: { generateText: (p: { prompt: string }) => Promise<unknown> };
  };
  onDone: () => void;
}) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('welcome');
  const [sectorsKey, setSectorsKey] = useState('');
  const [sectorsError, setSectorsError] = useState<string | undefined>();
  const [providerId, setProviderId] = useState<ProviderId>('bitdeer');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyError, setApiKeyError] = useState<string | undefined>();
  const [agentModel, setAgentModel] = useState('');
  const [routerModel, setRouterModel] = useState('');
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const provider = getProvider(providerId);
  const steps = ['Sectors API', 'AI Provider', 'Verify'];
  const currentIdx = step === 'welcome' ? 0 : step === 'sectors' ? 0 : step === 'provider' || step === 'apikey' || step === 'agentModel' || step === 'routerModel' ? 1 : 2;

  useInput((input, key) => {
    if (key.escape) {
      if (step === 'welcome') {
        exit();
        onDone();
      } else if (step === 'sectors') setStep('welcome');
      else if (step === 'provider') setStep('sectors');
      else if (step === 'apikey') setStep('provider');
      else if (step === 'agentModel') setStep('apikey');
      else if (step === 'routerModel') setStep('agentModel');
      else if (step === 'testing') setStep('routerModel');
      else if (step === 'done') {
        onDone();
      }
    }
    if (step === 'welcome' && key.return) {
      setStep('sectors');
    }
    if (step === 'done' && key.return) {
      onDone();
    }
    if (step === 'testing' && result) {
      if (input === 'r') {
        setResult(null);
        setRetryCount((c: number) => c + 1);
      }
      if (input === 'b') setStep('routerModel');
      if (key.return && result.sectors.ok && result.agent.ok && result.router.ok) {
        setStep('done');
        // slight delay then onDone
        setTimeout(() => onDone(), 100);
      }
    }
  });

  // Auto-run test when entering testing
  useEffect(() => {
    if (step !== 'testing') return;
    let cancelled = false;
    (async () => {
      // Persist before testing (Slice 2: save immediately on entering testing)
      try {
        if (sectorsKey) saveSectorsKey(homeDir, sectorsKey);
      } catch {}
      try {
        if (apiKey && agentModel && routerModel) saveProvider(homeDir, providerId, apiKey, agentModel, routerModel);
      } catch {}
      const r = await testConnections(deps);
      if (!cancelled) setResult(r);
    })();
    return () => {
      cancelled = true;
    };
  }, [step, retryCount]);

  const handleSectorsSubmit = (v: string) => {
    const err = validateSectorsKey(v);
    if (err) {
      setSectorsError(err);
      return;
    }
    setSectorsKey(v.trim());
    setSectorsError(undefined);
    setStep('provider');
  };

  const handleApiKeySubmit = (v: string) => {
    if (!v.trim()) {
      setApiKeyError('API key is required');
      return;
    }
    setApiKey(v.trim());
    setApiKeyError(undefined);
    // init default models from provider
    const prov = getProvider(providerId);
    setAgentModel(prov?.models[0]?.id ?? '');
    setStep('agentModel');
  };

  if (step === 'welcome') {
    return (
      <Box flexDirection="column">
        <Text>⚡ FinHarness</Text>
        <Text>Evidence-based financial research agent</Text>
        <Text> </Text>
        <Text>Welcome! Let's set up FinHarness.</Text>
        <Text>─────────────────────────────────────</Text>
        <StepIndicator steps={steps} current={currentIdx} />
        <Text dimColor>Press Enter to begin  [Esc] Exit</Text>
      </Box>
    );
  }

  if (step === 'sectors') {
    return (
      <Box flexDirection="column">
        <Text bold>Sectors API</Text>
        <Text>FinHarness uses Sectors API to retrieve company and financial data.</Text>
        <Text dimColor>{SECTORS_KEY_HINT}</Text>
        <Text>API Key</Text>
        <SecretInput value={sectorsKey} onChange={setSectorsKey} onSubmit={handleSectorsSubmit} />
        {sectorsError ? <Text color="red">{sectorsError}</Text> : null}
        <Text dimColor>[Enter] Continue  [Esc] Back</Text>
        {sectorsKey ? <Text color="green">✓ Sectors API configured</Text> : null}
      </Box>
    );
  }

  if (step === 'provider') {
    return (
      <Box flexDirection="column">
        <Text bold>AI Provider</Text>
        <Text>Choose how FinHarness should run its AI models.</Text>
        <ProviderSelector
          onSelect={(id) => {
            setProviderId(id);
            setStep('apikey');
          }}
        />
        <Text dimColor>↑/↓ navigate · Enter select · Esc back</Text>
      </Box>
    );
  }

  if (step === 'apikey') {
    return (
      <Box flexDirection="column">
        <Text bold>{provider?.label ?? 'Provider'}</Text>
        <Text>API Key</Text>
        <SecretInput value={apiKey} onChange={setApiKey} onSubmit={handleApiKeySubmit} />
        {apiKeyError ? <Text color="red">{apiKeyError}</Text> : null}
        <Text dimColor>[Enter] Continue  [Esc] Back</Text>
      </Box>
    );
  }

  if (step === 'agentModel') {
    const prov = getProvider(providerId);
    return (
      <Box flexDirection="column">
        <Text bold>Agent model</Text>
        <ModelSelector
          models={prov?.models ?? []}
          onSelect={(id) => {
            setAgentModel(id);
            setStep('routerModel');
          }}
        />
        <Text dimColor>↑/↓ navigate · Enter select · Esc back</Text>
      </Box>
    );
  }

  if (step === 'routerModel') {
    const prov = getProvider(providerId);
    return (
      <Box flexDirection="column">
        <Text bold>Router model</Text>
        <ModelSelector
          models={prov?.models ?? []}
          onSelect={(id) => {
            setRouterModel(id);
            setStep('testing');
          }}
        />
        <Text dimColor>↑/↓ navigate · Enter select · Esc back</Text>
      </Box>
    );
  }

  if (step === 'testing') {
    const allOk = result ? result.sectors.ok && result.agent.ok && result.router.ok : false;
    return (
      <Box flexDirection="column">
        {!result ? <Text>◇ Testing configuration...</Text> : <ConnectionTest result={result} />}
        {result ? (
          allOk ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color="green">Setup complete.</Text>
              <Text>You're ready to research.</Text>
              <Text>Try: "Analyze BBCA's latest financial performance"</Text>
              <Text dimColor>Press Enter to continue  [r] Retry  [b] Back</Text>
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <Text color="red">Some checks failed.</Text>
              <Text dimColor>[r] Retry  [b] Back  [Esc] Exit setup</Text>
            </Box>
          )
        ) : null}
      </Box>
    );
  }

  // done
  return (
    <Box flexDirection="column">
      <Text color="green">Setup complete.</Text>
      <Text>⚡ FinHarness — Ready · {provider?.label} · {agentModel}</Text>
      <Text dimColor>Press Enter to continue</Text>
    </Box>
  );
}
