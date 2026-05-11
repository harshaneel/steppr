from dataclasses import dataclass, field


@dataclass
class WorkflowMessage:
    execution_id: str
    workflow_id: str
    node_id: str
    node_type: str
    metadata: dict
    payload: dict


@dataclass
class BranchResult:
    condition: str
    output: dict
    next_node: str


@dataclass
class NodeResponse:
    execution_id: str
    node_id: str
    status: str  # "success" | "failure"
    output: dict
    error: dict | None = None

    def to_dict(self) -> dict:
        d = {
            "execution_id": self.execution_id,
            "node_id": self.node_id,
            "status": self.status,
            "output": self.output,
        }
        if self.error:
            d["error"] = self.error
        return d


@dataclass
class FilterResponse:
    execution_id: str
    node_id: str
    status: str  # "success" | "failure"
    branches: list[BranchResult] = field(default_factory=list)
    error: dict | None = None

    def to_dict(self) -> dict:
        d = {
            "execution_id": self.execution_id,
            "node_id": self.node_id,
            "status": self.status,
            "branches": [
                {"condition": b.condition, "output": b.output, "next_node": b.next_node}
                for b in self.branches
            ],
        }
        if self.error:
            d["error"] = self.error
        return d
