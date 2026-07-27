"""Host-local credential bridge for the sealed Dark Factory Pi Harbor adapter."""

from __future__ import annotations

import os

from dark_factory_pi import DarkFactoryPi as _ProductionDarkFactoryPi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class DarkFactoryPi(_ProductionDarkFactoryPi):
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        api_key = os.environ.get("ANTHROPIC_FOUNDRY_API_KEY")
        if not api_key:
            raise RuntimeError("Local Foundry authentication was not loaded")
        with environment.scoped_exec_env(
            {"ANTHROPIC_FOUNDRY_API_KEY": api_key}
        ):
            await super().run(instruction, environment, context)
