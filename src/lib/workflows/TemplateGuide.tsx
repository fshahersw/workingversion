import { useState } from "react";
import type { AppTemplate } from "./app-templates";
import { Button, Icon, Modal } from "./ui";
import { downloadBlob } from "./files";

export function TemplateGuide({
  template,
  onUse,
  onBuild,
}: {
  template: AppTemplate;
  onUse?: () => void;
  onBuild?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const guide = template.guide;
  if (!guide) return null;
  return (
    <>
      <button
        className="swf-text-button swf-guide-button"
        onClick={() => setOpen(true)}
        aria-label={`Guide for ${template.name}`}
      >
        <Icon name="Info" size={13} />
        How this works
      </button>
      {open && (
        <Modal
          wide
          title={template.name}
          description={template.description}
          onClose={() => setOpen(false)}
        >
          <div className="swf-template-guide">
            <div className="swf-guide-roles">
              {guide.roles.map((role) => (
                <span key={role}>{role}</span>
              ))}
            </div>
            <dl>
              <dt>Stage</dt>
              <dd>{guide.stage}</dd>
              <dt>Use it</dt>
              <dd>{guide.cadence}</dd>
              <dt>Supply</dt>
              <dd>{guide.inputGuide}</dd>
              <dt>Deliverable</dt>
              <dd>{template.output}</dd>
              <dt>Reviewer</dt>
              <dd>{guide.reviewer}</dd>
            </dl>
            <h3>Workflow</h3>
            <ol>
              {guide.process.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ol>
            <h3>Review before use</h3>
            <ul>
              {guide.reviewChecks.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="swf-guide-boundary">{guide.boundary}</p>
            <a href={template.source} target="_blank" rel="noreferrer">
              Professional reference <Icon name="ExternalLink" size={13} />
            </a>
            <div className="swf-inline">
              {onUse && (
                <Button
                  variant="primary"
                  icon="Play"
                  onClick={() => {
                    setOpen(false);
                    onUse();
                  }}
                >
                  Use mini app
                </Button>
              )}
              {onBuild && (
                <Button
                  icon="GitBranch"
                  onClick={() => {
                    setOpen(false);
                    onBuild();
                  }}
                >
                  Build reviewed workflow
                </Button>
              )}
              <Button
                icon="Download"
                onClick={() =>
                  downloadBlob(
                    template.id + "-task-spec.json",
                    new Blob(
                      [
                        JSON.stringify(
                          {
                            templateId: template.id,
                            name: template.name,
                            guide,
                            config: template.config,
                            fields: template.fields,
                            reference: template.source,
                          },
                          null,
                          2,
                        ),
                      ],
                      { type: "application/json" },
                    ),
                  )
                }
              >
                Task specification
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
