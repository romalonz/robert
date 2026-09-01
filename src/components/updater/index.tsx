import { useState, useEffect } from "react";
import { Download, RefreshCw, ExternalLink } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@/components";
import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";

// The in-app control DETECTS an update (via the signed feed) but performs it only
// by launching the visible PowerShell terminal updater — real, watchable steps
// (download → close → install → relaunch). There is no silent in-app download.
export const Updater = () => {
  const [available, setAvailable] = useState(false);
  const [version, setVersion] = useState("");
  const [launching, setLaunching] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    check()
      .then((u) => {
        if (u) {
          setAvailable(true);
          setVersion(u.version);
        }
      })
      .catch(() => {
        /* offline or no update — leave the control hidden */
      });
  }, []);

  if (!available) return null;

  const launch = async () => {
    setLaunching(true);
    try {
      // Opens a visible PowerShell window that runs update-robert.ps1.
      await invoke("robert_terminal_update");
    } catch {
      /* any failure surfaces in the terminal window itself */
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          className="cursor-pointer"
          title={`Update ${version} available`}
          aria-label={`Update ${version} available`}
        >
          <Download className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-72 p-4 border border-input/50 select-none"
      >
        <div className="space-y-3">
          <div>
            <h1 className="text-sm font-bold">Update available</h1>
            <p className="text-xs text-neutral-400 mt-1 leading-snug">
              Version {version} is ready. This opens a terminal window that
              downloads and installs it with visible steps, then reopens Robert.
            </p>
          </div>
          <Button
            onClick={launch}
            disabled={launching}
            className="w-full cursor-pointer text-xs"
          >
            {launching ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                Opening terminal…
              </>
            ) : (
              <>
                <ExternalLink className="mr-2 h-4 w-4" />
                Update in terminal
              </>
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
