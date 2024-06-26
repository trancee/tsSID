//cRSID CPU-emulation

import { UnsignedChar, UnsignedShort, Short, Int } from "./types";

import { C64 } from "./C64";
import { MEM } from "./MEM";

/**
 * Processor Flags
 *
 * The Processor flags are the bits of the 6502's 8-bit processor status register.
 * The behavior of many instructions is influenced by the state of one or more processor flags at the time of execution.
 * Additionally, some instructions may change the state of one or more flags.
 */
export const
    N = 0x80, // Negative: Set when an operation results in a negative number
    V = 0x40, // Overflow: Set when a signed addition or subtraction results in an overflow
    _ = 0x20, // Unused: This bit of the processor status register is not used
    B = 0x10, // Break: Set when a BRK instruction is executed
    D = 0x08, // Decimal Mode: When set, certain instructions operate in decimal rather than binary mode
    I = 0x04, // Interrupt Mask: When set, interrupt requests are ignored
    Z = 0x02, // Zero: Set when an operation results in a zero
    C = 0x01, // Carry: Set when an unsigned addition or subtraction results in an overflow
    NO_FLAGS = 0x00

const
    FlagSwitches: UnsignedChar = new UnsignedChar([0x01, 0x21, 0x04, 0x24, 0x00, 0x40, 0x08, 0x28])
const
    BranchFlags: UnsignedChar = new UnsignedChar([0x80, 0x40, 0x01, 0x02])

// Vectors
export const
    STACK = 0x0100,
    NMI = 0xFFFA,
    RESET = 0xFFFC,
    IRQ = 0xFFFE

export let Cycles: number = 0, SamePage: number = 0;
export const IR: UnsignedChar = new UnsignedChar(1), ST: UnsignedChar = new UnsignedChar(1), X: UnsignedChar = new UnsignedChar(1), Y: UnsignedChar = new UnsignedChar(1);
export const A: Short = new Short(1), SP: Short = new Short(1), T: Short = new Short(1);
export const PC: UnsignedShort = new UnsignedShort(1), Addr: UnsignedShort = new UnsignedShort(1), PrevPC: UnsignedShort = new UnsignedShort(1);

export class CPU {
    #PC: UnsignedShort = new UnsignedShort(1);
    #A: Short = new Short(1); #SP: Short = new Short(1);
    #X: UnsignedChar = new UnsignedChar(1); #Y: UnsignedChar = new UnsignedChar(1); #ST: UnsignedChar = new UnsignedChar(1);  //STATUS-flags: N V - B D I Z C
    #PrevNMI: UnsignedChar = new UnsignedChar(1); //used for NMI leading edge detection

    // Program Counter
    set PC(value: number) { this.#PC[0] = value }
    get PC(): number { return this.#PC[0] }

    // Accumulator
    set A(value: number) { this.#A[0] = value }
    get A(): number { return this.#A[0] }
    // Stack Pointer
    set SP(value: number) { this.#SP[0] = value }
    get SP(): number { return this.#SP[0] }
    set S(value: number) { this.#SP[0] = value }
    get S(): number { return this.#SP[0] }

    // X Index Register
    set X(value: number) { this.#X[0] = value }
    get X(): number { return this.#X[0] }
    // Y Index Register
    set Y(value: number) { this.#Y[0] = value }
    get Y(): number { return this.#Y[0] }
    // Processor Status
    set ST(value: number) { this.#ST[0] = value }
    get ST(): number { return this.#ST[0] }
    set P(value: number) { this.#ST[0] = value }
    get P(): number { return this.#ST[0] }

    set PrevNMI(value: number) { this.#PrevNMI[0] = value }
    get PrevNMI(): number { return this.#PrevNMI[0] }

    constructor(mempos: number = 0x0000) {
        this.initCPU(mempos)
    }

    initCPU(mempos: number): void {
        this.PC = mempos; this.A = 0; this.X = 0; this.Y = 0; this.ST = 0x04; this.SP = 0xFF; this.PrevNMI = 0;
    }

    static reset(): void { Cycles = 0; SamePage = 0; IR[0] = 0; ST[0] = 0; X[0] = 0; Y[0] = 0; A[0] = 0; SP[0] = 0; T[0] = 0; PC[0] = 0; Addr[0] = 0; PrevPC[0] = 0; }

    loadReg(): void { PC[0] = this.PC; SP[0] = this.SP; ST[0] = this.ST; A[0] = this.A; X[0] = this.X; Y[0] = this.Y; }
    storeReg(): void { this.PC = PC[0]; this.SP = SP[0]; this.ST = ST[0]; this.A = A[0]; this.X = X[0]; this.Y = Y[0]; }

    static rd(address: number): UnsignedChar {
        const value: UnsignedChar = MEM.readMem(address);
        if (C64.RealSIDmode) {
            if (C64.RAMbank[1] & 3) {
                if (address == 0xDC0D) { C64.CIA[1].acknowledgeCIAIRQ(); }
                else if (address == 0xDD0D) { C64.CIA[2].acknowledgeCIAIRQ(); }
            }
        }
        return value;
    }

    static wr(address: number, data: number): void {
        MEM.writeMem(address, data)
        if (C64.RealSIDmode && (C64.RAMbank[1] & 3)) {
            //if(data&1) { //only writing 1 to $d019 bit0 would acknowledge, not any value (but RMW instructions write $d019 back before mod.)
            if (address == 0xD019) { C64.VIC.acknowledgeVICrasterIRQ(); }
            //}
        }
    }

    static wr2(address: number, data: UnsignedChar): void { //PSID-hack specific memory-write
        const Tmp: Int = new Int(1);
        MEM.writeMem(address, data[0]);
        if (C64.RAMbank[1] & 3) {
            if (C64.RealSIDmode) {
                if (address == 0xDC0D) C64.CIA[1].writeCIAIRQmask(data[0]);
                else if (address == 0xDD0D) C64.CIA[2].writeCIAIRQmask(data[0]);
                else if (address == 0xDD0C) C64.IObankRD[address] = data[0]; //mirror WR to RD (e.g. Wonderland_XIII_tune_1.sid)
                //#ifdef PLATFORM_PC //just for info displayer
                // else if (address==0xDC05 || address==0xDC04) C64->FrameCycles = ( (C64->IObankWR[0xDC04] + (C64->IObankWR[0xDC05]<<8)) );
                //#endif
                else if (address == 0xD019 && data[0] & 1) { //only writing 1 to $d019 bit0 would acknowledge
                    C64.VIC.acknowledgeVICrasterIRQ();
                }
            }

            else {
                switch (address) {
                    case 0xDC05: case 0xDC04:
                        if (C64.TimerSource) { //dynamic CIA-setting (Galway/Rubicon workaround)
                            C64.FrameCycles = ((C64.IObankWR[0xDC04] + (C64.IObankWR[0xDC05] << 8))); //<< 4) / C64->SampleClockRatio;
                        }
                        break;
                    case 0xDC08: C64.IObankRD[0xDC08] = data[0]; break; //refresh TOD-clock
                    case 0xDC09: C64.IObankRD[0xDC09] = data[0]; break; //refresh TOD-clock
                    case 0xD012: //dynamic VIC IRQ-rasterline setting (Microprose Soccer V1 workaround)
                        if (C64.PrevRasterLine >= 0) { //was $d012 set before? (or set only once?)
                            if (C64.IObankWR[0xD012] != C64.PrevRasterLine) {
                                Tmp[0] = C64.IObankWR[0xD012] - C64.PrevRasterLine;
                                if (Tmp[0] < 0) Tmp[0] += C64.VIC.RasterLines;
                                C64.FrameCycleCnt = (C64.FrameCycles - Tmp[0] * C64.VIC.RasterRowCycles);
                            }
                        }
                        C64.PrevRasterLine = C64.IObankWR[0xD012];
                        break;
                }
            }

        }
    }

    static addrModeImmediate(): void { ++PC[0]; Addr[0] = PC[0]; Cycles = 2; } //imm.
    static addrModeZeropage(): void { ++PC[0]; Addr[0] = CPU.rd(PC[0])[0]; Cycles = 3; } //zp
    static addrModeAbsolute(): void { ++PC[0]; Addr[0] = CPU.rd(PC[0])[0]; ++PC[0]; Addr[0] += CPU.rd(PC[0])[0] << 8; Cycles = 4; } //abs
    static addrModeZeropageXindexed(): void { ++PC[0]; Addr[0] = (CPU.rd(PC[0])[0] + X[0]) & 0xFF; Cycles = 4; } //zp,x (with zeropage-wraparound of 6502)
    static addrModeZeropageYindexed(): void { ++PC[0]; Addr[0] = (CPU.rd(PC[0])[0] + Y[0]) & 0xFF; Cycles = 4; } //zp,y (with zeropage-wraparound of 6502)

    static addrModeXindexed(): void { // abs,x (only STA is 5 cycles, others are 4 if page not crossed, RMW:7)
        ++PC[0]; Addr[0] = CPU.rd(PC[0])[0] + X[0]; ++PC[0]; SamePage = Number(Addr[0] <= 0xFF); Addr[0] += CPU.rd(PC[0])[0] << 8; Cycles = 5;
    }

    static addrModeYindexed(): void { // abs,y (only STA is 5 cycles, others are 4 if page not crossed, RMW:7)
        ++PC[0]; Addr[0] = CPU.rd(PC[0])[0] + Y[0]; ++PC[0]; SamePage = Number(Addr[0] <= 0xFF); Addr[0] += CPU.rd(PC[0])[0] << 8; Cycles = 5;
    }

    static addrModeIndirectYindexed(): void { // (zp),y (only STA is 6 cycles, others are 5 if page not crossed, RMW:8)
        ++PC[0]; Addr[0] = CPU.rd(CPU.rd(PC[0])[0])[0] + Y[0]; SamePage = Number(Addr[0] <= 0xFF); Addr[0] += CPU.rd((CPU.rd(PC[0])[0] + 1) & 0xFF)[0] << 8; Cycles = 6;
    }

    static addrModeXindexedIndirect(): void { // (zp,x)
        ++PC[0]; Addr[0] = (CPU.rd(CPU.rd(PC[0])[0] + X[0])[0] & 0xFF) + ((CPU.rd(CPU.rd(PC[0])[0] + X[0] + 1)[0] & 0xFF) << 8); Cycles = 6;
    }

    static clrC() { ST[0] &= ~C; } //clear Carry-flag
    static setC(expr: number | boolean) { ST[0] &= ~C; ST[0] |= Number(expr != 0); } //set Carry-flag if expression is not zero
    static clrNZC() { ST[0] &= ~(N | Z | C); } //clear flags
    static clrNVZC() { ST[0] &= ~(N | V | Z | C); } //clear flags
    static setNZbyA() { ST[0] &= ~(N | Z); ST[0] |= (Number(!A[0]) << 1) | (A[0] & N); } //set Negative-flag and Zero-flag based on result in Accumulator
    static setNZbyT() { T[0] &= 0xFF; ST[0] &= ~(N | Z); ST[0] |= (Number(!T[0]) << 1) | (T[0] & N); }
    static setNZbyX() { ST[0] &= ~(N | Z); ST[0] |= (Number(!X[0]) << 1) | (X[0] & N); } //set Negative-flag and Zero-flag based on result in X-register
    static setNZbyY() { ST[0] &= ~(N | Z); ST[0] |= (Number(!Y[0]) << 1) | (Y[0] & N); } //set Negative-flag and Zero-flag based on result in Y-register
    static setNZbyM() { ST[0] &= ~(N | Z); ST[0] |= (Number(!CPU.rd(Addr[0])[0]) << 1) | (CPU.rd(Addr[0])[0] & N); } //set Negative-flag and Zero-flag based on result at Memory-Address
    static setNZCbyAdd() { ST[0] &= ~(N | Z | C); ST[0] |= (A[0] & N) | Number(A[0] > 0xFF); A[0] &= 0xFF; ST[0] |= Number(!A[0]) << 1; } //after increase/addition
    static setVbyAdd(M: number) { ST[0] &= ~V; ST[0] |= ((~(T[0] ^ M)) & (T[0] ^ A[0]) & N) >> 1; } //calculate V-flag from A and T (previous A) and input2 (Memory)
    static setNZCbySub(val: Short): Short { ST[0] &= ~(N | Z | C); ST[0] |= (val[0] & N) | Number(val[0] >= 0); val[0] &= 0xFF; ST[0] |= (Number(!(val[0])) << 1); return val; }

    static push(value: number): void { C64.RAMbank[STACK + SP[0]] = value; --SP[0]; SP[0] &= 0xFF; } //push a value to stack
    static pop(): number { ++SP[0]; SP[0] &= 0xFF; return C64.RAMbank[STACK + SP[0]]; } //pop a value from stack

    emulateCPU(): number { //the CPU emulation for SID/PRG playback (ToDo: CIA/VIC-IRQ/NMI/RESET vectors, BCD-mode)
        // const C64: C64 = C64; //could be a parameter but function-call is faster this way if only 1 main CPU exists
        // const CPU: CPU = C64.CPU;

        // let Cycles: number, SamePage: number;
        // const IR: UnsignedChar = new UnsignedChar(1), ST: UnsignedChar = new UnsignedChar(1), X: UnsignedChar = new UnsignedChar(1), Y: UnsignedChar = new UnsignedChar(1);
        // const A: Short = new Short(1), SP: Short = new Short(1), T: Short = new Short(1);
        // const PC: UnsignedShort = new UnsignedShort(1), Addr: UnsignedShort = new UnsignedShort(1), PrevPC: UnsignedShort = new UnsignedShort(1);

        const loadReg = this.loadReg.bind(this)
        const storeReg = this.storeReg.bind(this)

        const rd = CPU.rd
        const wr = CPU.wr
        const wr2 = CPU.wr2

        const push = CPU.push
        const pop = CPU.pop

        loadReg(); PrevPC[0] = PC[0];
        IR[0] = rd(PC[0])[0]; Cycles = 2; SamePage = 0; //'Cycles': ensure smallest 6510 runtime (for implied/register instructions)

        if (IR[0] & 1) {  //nybble2:  1/5/9/D:accu.instructions, 3/7/B/F:illegal opcodes

            switch ((IR[0] & 0x1F) >> 1) { //value-forming to cause jump-table //PC wraparound not handled inside to save codespace
                case 0x00: case 0x01: CPU.addrModeXindexedIndirect(); break; //(zp,x)
                case 0x02: case 0x03: CPU.addrModeZeropage(); break;
                case 0x04: case 0x05: CPU.addrModeImmediate(); break;
                case 0x06: case 0x07: CPU.addrModeAbsolute(); break;
                case 0x08: case 0x09: CPU.addrModeIndirectYindexed(); break; //(zp),y (5..6 cycles, 8 for R-M-W)
                case 0x0A: CPU.addrModeZeropageXindexed(); break; //zp,x
                case 0x0B: if ((IR[0] & 0xC0) != 0x80) CPU.addrModeZeropageXindexed(); //zp,x for illegal opcodes
                else CPU.addrModeZeropageYindexed(); //zp,y for LAX/SAX illegal opcodes
                    break;
                case 0x0C: case 0x0D: CPU.addrModeYindexed(); break;
                case 0x0E: CPU.addrModeXindexed(); break;
                case 0x0F: if ((IR[0] & 0xC0) != 0x80) CPU.addrModeXindexed(); //abs,x for illegal opcodes
                else CPU.addrModeYindexed(); //abs,y for LAX/SAX illegal opcodes
                    break;
            }
            Addr[0] &= 0xFFFF;

            switch ((IR[0] & 0xE0) >> 5) { //value-forming to cause gapless case-values and faster jump-table creation from switch-case

                case 0: if ((IR[0] & 0x1F) != 0x0B) { //ORA / SLO(ASO)=ASL+ORA
                    if ((IR[0] & 3) == 3) { CPU.clrNZC(); CPU.setC(rd(Addr[0])[0] >= N); wr(Addr[0], rd(Addr[0])[0] << 1); Cycles += 2; } //for SLO
                    else Cycles -= SamePage;
                    A[0] |= rd(Addr[0])[0]; CPU.setNZbyA(); //ORA
                }
                else { A[0] &= rd(Addr[0])[0]; CPU.setNZbyA(); CPU.setC(A[0] >= N); } //ANC (AND+Carry=bit7)
                    break;

                case 1: if ((IR[0] & 0x1F) != 0x0B) { //AND / RLA (ROL+AND)
                    if ((IR[0] & 3) == 3) { //for RLA
                        T[0] = (rd(Addr[0])[0] << 1) + (ST[0] & C); CPU.clrNZC(); CPU.setC(T[0] > 0xFF); T[0] &= 0xFF; wr(Addr[0], T[0]); Cycles += 2;
                    }
                    else Cycles -= SamePage;
                    A[0] &= rd(Addr[0])[0]; CPU.setNZbyA(); //AND
                }
                else { A[0] &= rd(Addr[0])[0]; CPU.setNZbyA(); CPU.setC(A[0] >= N); } //ANC (AND+Carry=bit7)
                    break;

                case 2: if ((IR[0] & 0x1F) != 0x0B) { //EOR / SRE(LSE)=LSR+EOR
                    if ((IR[0] & 3) == 3) { CPU.clrNZC(); CPU.setC(rd(Addr[0])[0] & 1); wr(Addr[0], rd(Addr[0])[0] >> 1); Cycles += 2; } //for SRE
                    else Cycles -= SamePage;
                    A[0] ^= rd(Addr[0])[0]; CPU.setNZbyA(); //EOR
                }
                else { A[0] &= rd(Addr[0])[0]; CPU.setC(A[0] & 1); A[0] >>= 1; A[0] &= 0xFF; CPU.setNZbyA(); } //ALR(ASR)=(AND+LSR)
                    break;

                case 3: if ((IR[0] & 0x1F) != 0x0B) { //RRA (ROR+ADC) / ADC
                    if ((IR[0] & 3) == 3) { //for RRA
                        T[0] = (rd(Addr[0])[0] >> 1) + ((ST[0] & C) << 7); CPU.clrNZC(); CPU.setC(T[0] & 1); wr(Addr[0], T[0]); Cycles += 2;
                    }
                    else Cycles -= SamePage;
                    T[0] = A[0]; A[0] += rd(Addr[0])[0] + (ST[0] & C);
                    if ((ST[0] & D) && (A[0] & 0x0F) > 9) { A[0] += 0x10; A[0] &= 0xF0; } //BCD?
                    CPU.setNZCbyAdd(); CPU.setVbyAdd(rd(Addr[0])[0]); //ADC
                }
                else { // ARR (AND+ROR, bit0 not going to C, but C and bit7 get exchanged.)
                    A[0] &= rd(Addr[0])[0]; T[0] += rd(Addr[0])[0] + (ST[0] & C);
                    CPU.clrNVZC(); CPU.setC(T[0] > 0xFF); CPU.setVbyAdd(rd(Addr[0])[0]); //V-flag set by intermediate ADC mechanism: (A&mem)+mem
                    T[0] = A[0]; A[0] = (A[0] >> 1) + ((ST[0] & C) << 7); CPU.setC(T[0] >= N); CPU.setNZbyA();
                }
                    break;

                case 4: if ((IR[0] & 0x1F) == 0x0B) { A[0] = X[0] & rd(Addr[0])[0]; CPU.setNZbyA(); } //XAA (TXA+AND), highly unstable on real 6502!
                else if ((IR[0] & 0x1F) == 0x1B) { SP[0] = A[0] & X[0]; wr(Addr[0], (SP[0] & ((Addr[0] >> 8) + 1))); } //TAS(SHS) (SP=A&X, mem=S&H} - unstable on real 6502
                else { wr2(Addr[0], new UnsignedChar([A[0] & (((IR[0] & 3) == 3) ? X[0] : 0xFF)])); } //STA / SAX (at times same as AHX/SHX/SHY) (illegal)
                    break;

                case 5: if ((IR[0] & 0x1F) != 0x1B) { A[0] = rd(Addr[0])[0]; if ((IR[0] & 3) == 3) X[0] = A[0]; } //LDA / LAX (illegal, used by my 1 rasterline player) (LAX #imm is unstable on C64)
                else { A[0] = X[0] = SP[0] = (rd(Addr[0])[0] & SP[0]); } //LAS(LAR)
                    CPU.setNZbyA(); Cycles -= SamePage;
                    break;

                case 6: if ((IR[0] & 0x1F) != 0x0B) { // CMP / DCP(DEC+CMP)
                    if ((IR[0] & 3) == 3) { wr(Addr[0], (rd(Addr[0])[0] - 1)); Cycles += 2; } //DCP
                    else Cycles -= SamePage;
                    T[0] = A[0] - rd(Addr[0])[0];
                }
                else { X[0] = T[0] = (A[0] & X[0]) - rd(Addr[0])[0]; } //SBX(AXS)  //SBX (AXS) (CMP+DEX at the same time)
                    T[0] = CPU.setNZCbySub(T)[0];
                    break;

                case 7: if ((IR[0] & 3) == 3 && (IR[0] & 0x1F) != 0x0B) { wr(Addr[0], rd(Addr[0])[0] + 1); Cycles += 2; } //ISC(ISB)=INC+SBC / SBC
                else Cycles -= SamePage;
                    T[0] = A[0]; A[0] -= rd(Addr[0])[0] + Number(!(ST[0] & C));
                    A[0] = CPU.setNZCbySub(A)[0]; CPU.setVbyAdd(~rd(Addr[0])[0]);
                    break;
            }
        }

        else if (IR[0] & 2) {  //nybble2:  2:illegal/LDX, 6:A/X/INC/DEC, A:Accu-shift/reg.transfer/NOP, E:shift/X/INC/DEC

            switch (IR[0] & 0x1F) { //Addressing modes
                case 0x02: CPU.addrModeImmediate(); break;
                case 0x06: CPU.addrModeZeropage(); break;
                case 0x0E: CPU.addrModeAbsolute(); break;
                case 0x16: if ((IR[0] & 0xC0) != 0x80) CPU.addrModeZeropageXindexed(); //zp,x
                else CPU.addrModeZeropageYindexed(); //zp,y
                    break;
                case 0x1E: if ((IR[0] & 0xC0) != 0x80) CPU.addrModeXindexed(); //abs,x
                else CPU.addrModeYindexed(); //abs,y
                    break;
            }
            Addr[0] &= 0xFFFF;

            switch ((IR[0] & 0xE0) >> 5) {

                case 0: CPU.clrC(); case 1:
                    if ((IR[0] & 0x0F) == 0x0A) { A[0] = (A[0] << 1) + (ST[0] & C); CPU.setNZCbyAdd(); } //ASL/ROL (Accu)
                    else { T[0] = (rd(Addr[0])[0] << 1) + (ST[0] & C); CPU.setC(T[0] > 0xFF); CPU.setNZbyT(); wr(Addr[0], T[0]); Cycles += 2; } //RMW (Read-Write-Modify)
                    break;

                case 2: CPU.clrC(); case 3:
                    if ((IR[0] & 0x0F) == 0x0A) { T[0] = A[0]; A[0] = (A[0] >> 1) + ((ST[0] & C) << 7); CPU.setC(T[0] & 1); A[0] &= 0xFF; CPU.setNZbyA(); } //LSR/ROR (Accu)
                    else { T[0] = (rd(Addr[0])[0] >> 1) + ((ST[0] & C) << 7); CPU.setC(rd(Addr[0])[0] & 1); CPU.setNZbyT(); wr(Addr[0], T[0]); Cycles += 2; } //memory (RMW)
                    break;

                case 4: if (IR[0] & 4) { wr2(Addr[0], new UnsignedChar([X[0]])); } //STX
                else if (IR[0] & 0x10) SP[0] = X[0]; //TXS
                else { A[0] = X[0]; CPU.setNZbyA(); } //TXA
                    break;

                case 5: if ((IR[0] & 0x0F) != 0x0A) { X[0] = rd(Addr[0])[0]; Cycles -= SamePage; } //LDX
                else if (IR[0] & 0x10) X[0] = SP[0]; //TSX
                else X[0] = A[0]; //TAX
                    CPU.setNZbyX();
                    break;

                case 6: if (IR[0] & 4) { wr(Addr[0], rd(Addr[0])[0] - 1); CPU.setNZbyM(); Cycles += 2; } //DEC
                else { --X[0]; CPU.setNZbyX(); } //DEX
                    break;

                case 7: if (IR[0] & 4) { wr(Addr[0], rd(Addr[0])[0] + 1); CPU.setNZbyM(); Cycles += 2; } //INC/NOP
                    break;
            }
        }

        else if ((IR[0] & 0x0C) == 8) {  //nybble2:  8:register/statusflag
            if (IR[0] & 0x10) {
                if (IR[0] == 0x98) { A[0] = Y[0]; CPU.setNZbyA(); } //TYA
                else { //CLC/SEC/CLI/SEI/CLV/CLD/SED
                    if (FlagSwitches[IR[0] >> 5] & 0x20) ST[0] |= (FlagSwitches[IR[0] >> 5] & 0xDF);
                    else ST[0] &= ~(FlagSwitches[IR[0] >> 5] & 0xDF);
                }
            }
            else {
                switch ((IR[0] & 0xF0) >> 5) {
                    case 0: push(ST[0]); Cycles = 3; break; //PHP
                    case 1: ST[0] = pop(); Cycles = 4; break; //PLP
                    case 2: push(A[0]); Cycles = 3; break; //PHA
                    case 3: A[0] = pop(); CPU.setNZbyA(); Cycles = 4; break; //PLA
                    case 4: --Y[0]; CPU.setNZbyY(); break; //DEY
                    case 5: Y[0] = A[0]; CPU.setNZbyY(); break; //TAY
                    case 6: ++Y[0]; CPU.setNZbyY(); break; //INY
                    case 7: ++X[0]; CPU.setNZbyX(); break; //INX
                }
            }
        }

        else {  //nybble2:  0: control/branch/Y/compare  4: Y/compare  C:Y/compare/JMP

            if ((IR[0] & 0x1F) == 0x10) { //BPL/BMI/BVC/BVS/BCC/BCS/BNE/BEQ  relative branch
                ++PC[0];
                T[0] = rd(PC[0])[0]; if (T[0] & 0x80) T[0] -= 0x0100;
                if (IR[0] & 0x20) {
                    if (ST[0] & BranchFlags[IR[0] >> 6]) { PC[0] += T[0]; Cycles = 3; }
                }
                else {
                    if (!(ST[0] & BranchFlags[IR[0] >> 6])) { PC[0] += T[0]; Cycles = 3; } //plus 1 cycle if page is crossed?
                }
            }

            else {  //nybble2:  0:Y/control/Y/compare  4:Y/compare  C:Y/compare/JMP
                switch (IR[0] & 0x1F) { //Addressing modes
                    case 0x00: CPU.addrModeImmediate(); break; //imm. (or abs.low for JSR/BRK)
                    case 0x04: CPU.addrModeZeropage(); break;
                    case 0x0C: CPU.addrModeAbsolute(); break;
                    case 0x14: CPU.addrModeZeropageXindexed(); break; //zp,x
                    case 0x1C: CPU.addrModeXindexed(); break; //abs,x
                }
                Addr[0] &= 0xFFFF;

                switch ((IR[0] & 0xE0) >> 5) {

                    case 0: if (!(IR[0] & 4)) { //BRK / NOP-absolute/abs,x/zp/zp,x
                        push((PC[0] + 2 - 1) >> 8); push(((PC[0] + 2 - 1) & 0xFF)); push((ST[0] | B)); ST[0] |= I; //BRK
                        PC[0] = rd(IRQ + 0)[0] + (rd(IRQ + 1)[0] << 8) - 1; Cycles = 7;
                    }
                    else if (IR[0] == 0x1C) Cycles -= SamePage; //NOP abs,x
                        break;

                    case 1: if (IR[0] & 0x0F) { //BIT / NOP-abs,x/zp,x
                        if (!(IR[0] & 0x10)) { ST[0] &= 0x3D; ST[0] |= (rd(Addr[0])[0] & 0xC0) | (Number(!(A[0] & rd(Addr[0])[0])) << 1); } //BIT
                        else if (IR[0] == 0x3C) Cycles -= SamePage; //NOP abs,x
                    }
                    else { //JSR
                        push((PC[0] + 2 - 1) >> 8); push(((PC[0] + 2 - 1) & 0xFF));
                        PC[0] = rd(Addr[0])[0] + rd(Addr[0] + 1)[0] * 256 - 1; Cycles = 6;
                    }
                        break;

                    case 2: if (IR[0] & 0x0F) { //JMP / NOP-abs,x/zp/zp,x
                        if (IR[0] == 0x4C) { //JMP
                            PC[0] = Addr[0] - 1; Cycles = 3;
                            rd(Addr[0] + 1); //a read from jump-address highbyte is used in some tunes with jmp DD0C (e.g. Wonderland_XIII_tune_1.sid)
                            //if (Addr[0]==PrevPC[0]) {storeReg(); C64->Returned=1; return 0xFF;} //turn self-jump mainloop (after init) into idle time
                        }
                        else if (IR[0] == 0x5C) Cycles -= SamePage; //NOP abs,x
                    }
                    else { //RTI
                        ST[0] = pop(); T[0] = pop(); PC[0] = (pop() << 8) + T[0] - 1; Cycles = 6;
                        if (C64.Returned && SP[0] >= 0xFF) { ++PC[0]; storeReg(); return 0xFE; }
                    }
                        break;

                    case 3: if (IR[0] & 0x0F) { //JMP() (indirect) / NOP-abs,x/zp/zp,x
                        if (IR[0] == 0x6C) { //JMP() (indirect)
                            PC[0] = rd((Addr[0] & 0xFF00) + ((Addr[0] + 1) & 0xFF))[0]; //(with highbyte-wraparound bug)
                            PC[0] = (PC[0] << 8) + rd(Addr[0])[0] - 1; Cycles = 5;
                        }
                        else if (IR[0] == 0x7C) Cycles -= SamePage; //NOP abs,x
                    }
                    else { //RTS
                        if (SP[0] >= 0xFF) { storeReg(); C64.Returned = true; return 0xFF; } //Init returns, provide idle-time between IRQs
                        T[0] = pop(); PC[0] = (pop() << 8) + T[0]; Cycles = 6;
                    }
                        break;

                    case 4: if (IR[0] & 4) { wr2(Addr[0], new UnsignedChar([Y[0]])); } //STY / NOP #imm
                        break;

                    case 5: Y[0] = rd(Addr[0])[0]; CPU.setNZbyY(); Cycles -= SamePage; //LDY
                        break;

                    case 6: if (!(IR[0] & 0x10)) { //CPY / NOP abs,x/zp,x
                        T[0] = Y[0] - rd(Addr[0])[0]; T[0] = CPU.setNZCbySub(T)[0]; //CPY
                    }
                    else if (IR[0] == 0xDC) Cycles -= SamePage; //NOP abs,x
                        break;

                    case 7: if (!(IR[0] & 0x10)) { //CPX / NOP abs,x/zp,x
                        T[0] = X[0] - rd(Addr[0])[0]; T[0] = CPU.setNZCbySub(T)[0]; //CPX
                    }
                    else if (IR[0] == 0xFC) Cycles -= SamePage; //NOP abs,x
                        break;
                }
            }
        }

        ++PC[0]; //PC&=0xFFFF;

        storeReg();

        if (!C64.RealSIDmode) { //substitute KERNAL IRQ-return in PSID (e.g. Microprose Soccer)
            if ((C64.RAMbank[1] & 3) > 1 && PrevPC[0] < 0xE000 && (PC[0] == 0xEA31 || PC[0] == 0xEA81 || PC[0] == 0xEA7E)) return 0xFE;
        }

        return Cycles;
    }

    //handle entering into IRQ and NMI interrupt
    handleCPUinterrupts(): boolean {
        const push = (value: number): void => { C64.RAMbank[STACK + this.SP] = value; --this.SP; this.SP &= 0xFF; } //push a value to stack

        if (C64.NMI > this.PrevNMI) { //if IRQ and NMI at the same time, NMI is serviced first
            push(this.PC >> 8); push((this.PC & 0xFF)); push(this.ST); this.ST |= I;
            this.PC = MEM.readMem(NMI + 0)[0] + (MEM.readMem(NMI + 1)[0] << 8); //NMI-vector
            this.PrevNMI = C64.NMI;
            return true;
        }
        else if (C64.IRQ && !(this.ST & I)) {
            push(this.PC >> 8); push((this.PC & 0xFF)); push(this.ST); this.ST |= I;
            this.PC = MEM.readMem(IRQ + 0)[0] + (MEM.readMem(IRQ + 1)[0] << 8); //maskable IRQ-vector
            this.PrevNMI = C64.NMI;
            return true;
        }
        this.PrevNMI = C64.NMI; //prepare for NMI edge-detection

        return false;
    }
}
